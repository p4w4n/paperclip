// Bidi handler for Worker.Connect. v1 covers the handshake (Hello →
// Welcome), application-level Ping/Pong liveness, and registration in the
// in-memory WorkerRegistry. Run dispatch, log streaming, lease frames, and
// drain handling are layered in by Tasks 8, 9, and the lease-reaper task
// once the underlying state machine is ready.

import * as grpc from "@grpc/grpc-js";
import { create } from "@bufbuild/protobuf";
import {
  type WorkerToServer,
  type ServerToWorker,
  ServerToWorkerSchema,
  WelcomeSchema,
  PingSchema,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry, RegisteredWorker } from "../services/worker-registry.js";
import { settleRunCompletion } from "../adapters/run-completion-registry.js";
import type { RunDispatcher } from "../services/run-dispatcher.js";
import { handleServiceStatus } from "./service-status-handler.js";

// gRPC keepalive guarantees the *transport* is alive; the application Ping
// is a separate channel that proves the *application* is responsive (proto
// frames flowing, not just TCP packets).
const PING_INTERVAL_MS = 15_000;
const PONG_DEADLINE_MS = 60_000;

export interface HandleConnectOpts {
  auth: WorkerAuthStrategy;
  registry: WorkerRegistry;
  dispatcher: RunDispatcher;
  // Plan 2 Task 4 — late-frame drop gate. Returns the workerId that
  // currently owns the run per heartbeat_runs.dispatched_to_worker_id,
  // or null if the row has been cleared (lease expired + reaper
  // requeued, or run already completed). On RunComplete/RunFailed, if
  // this returns a different workerId than the sender, we drop the
  // frame: spec failure-mode "first RunComplete wins, second dropped
  // (logged)". Optional — when omitted, the handler accepts every
  // frame (legacy / test behavior pre Plan 2).
  getCurrentDispatchedWorker?: (runId: string) => Promise<string | null>;
  // Plan 3 — row updater for inbound ServiceStatus frames; production
  // wires a Drizzle update on workspace_runtime_services. Optional —
  // when omitted, status frames are silently dropped.
  updateServiceStatus?: (runtimeServiceId: string, patch: Record<string, unknown>) => Promise<void>;
}

export async function handleConnect(
  call: grpc.ServerDuplexStream<WorkerToServer, ServerToWorker>,
  opts: HandleConnectOpts,
): Promise<void> {
  const headerValue = call.metadata.get("authorization")[0];
  const auth = await opts.auth.verify(typeof headerValue === "string" ? headerValue : undefined);
  if (!auth.ok) {
    call.destroy(new Error(`unauthorized: ${auth.reason}`));
    return;
  }

  let registered: RegisteredWorker | null = null;
  let lastSeen = Date.now();

  const send = async (m: ServerToWorker): Promise<void> => {
    if (call.writable) call.write(m);
  };

  const pingTimer = setInterval(() => {
    const elapsed = Date.now() - lastSeen;
    if (elapsed > PONG_DEADLINE_MS) {
      call.destroy(new Error("liveness timeout"));
      return;
    }
    void send(
      create(ServerToWorkerSchema, {
        payload: { case: "ping", value: create(PingSchema, { ts: BigInt(Date.now()) }) },
      }),
    );
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(pingTimer);
    if (registered) opts.registry.unregister(registered.workerId);
  };
  call.on("end", cleanup);
  call.on("error", cleanup);
  call.on("close", cleanup);

  // Spec NOTE N2: ANY worker frame referencing a run_id resets that run's
  // lease. Touching here (before the per-case dispatch) keeps the
  // bookkeeping in one place instead of repeating runDispatcher.touchLease
  // calls in each case branch — and crucially picks up future frame types
  // like RunSession without requiring this handler to be edited.
  const touchIfRun = (msg: WorkerToServer): void => {
    const p = msg.payload;
    if (
      p.case === "runComplete" ||
      p.case === "runFailed" ||
      p.case === "runLog" ||
      p.case === "runUsage" ||
      p.case === "runSession" ||
      p.case === "runLeaseRenew"
    ) {
      const runId = (p.value as { runId?: string }).runId;
      if (runId) opts.dispatcher.touchLease(runId);
    }
  };

  call.on("data", (msg: WorkerToServer) => {
    lastSeen = Date.now();
    touchIfRun(msg);
    const p = msg.payload;
    if (p.case === "hello") {
      // Spec NOTE N1: evict any prior registration for the same workerId.
      // workerId derives from the GCE instance_id and is durable across
      // worker process restarts within the same instance — so a duplicate
      // Hello means the previous process either crashed or rebooted, and
      // its old registration is stale. Disconnect the old session so its
      // lease-renewal frames stop being credible, then register the new one.
      const prior = opts.registry.get(p.value.workerId);
      if (prior) {
        try {
          prior.disconnect();
        } catch {
          /* ignore disconnect errors — cleanup is best-effort */
        }
        opts.registry.unregister(p.value.workerId);
      }
      registered = {
        workerId: p.value.workerId,
        instanceId: p.value.instanceId,
        adapters: [...p.value.adapters],
        maxConcurrent: Math.max(1, p.value.maxConcurrent),
        inFlight: 0,
        draining: false,
        send,
        disconnect: () => call.end(),
      };
      opts.registry.register(registered);
      // eslint-disable-next-line no-console
      console.log(
        `[worker-rpc] registered workerId=${registered.workerId} instance=${registered.instanceId} adapters=${registered.adapters.join(",")} maxConcurrent=${registered.maxConcurrent}`,
      );
      void send(
        create(ServerToWorkerSchema, {
          payload: {
            case: "welcome",
            value: create(WelcomeSchema, {
              workerId: registered.workerId,
              jwtTtlSeconds: 900,
              // scopedJwt and configHash get real values once secret-service
              // and config-snapshot wiring lands (Tasks 11 / 14).
              scopedJwt: "stub",
              configHash: "v1",
            }),
          },
        }),
      );
      return;
    }
    if (p.case === "pong") {
      // Liveness — lastSeen already updated above.
      return;
    }
    if (p.case === "runComplete") {
      // Settle the in-process promise the dispatch-or-local wrapper is
      // awaiting. The wrapper's `finally` then releases the worker's
      // slot via dispatcher.markCompleted. Also fire the dispatcher's
      // settlement listeners so direct-dispatch callers (the e2e test
      // path) observe completion without going through dispatch-or-local.
      const runId = p.value.runId;
      const result = {
        exitCode: p.value.exitCode,
        signal: p.value.signal || null,
        timedOut: false,
        summary: p.value.summary,
      };
      // Late-frame drop gate (Plan 2 Task 4). Async, so kick the look-up
      // off without blocking subsequent frames; if the row no longer
      // points at this worker, drop without settling.
      void (async () => {
        if (opts.getCurrentDispatchedWorker && registered) {
          const currentWid = await opts.getCurrentDispatchedWorker(runId);
          if (currentWid !== null && currentWid !== registered.workerId) {
            // eslint-disable-next-line no-console
            console.warn(
              `[worker-rpc] dropped RunComplete from ${registered.workerId} for run ${runId}; current owner is ${currentWid}`,
            );
            return;
          }
        }
        settleRunCompletion(runId, result);
        opts.dispatcher.notifySettlement(runId, { kind: "complete", payload: result });
      })();
      return;
    }
    if (p.case === "runFailed") {
      const runId = p.value.runId;
      const err = new Error(p.value.error || `run failed (${p.value.errorCode || "unknown"})`);
      void (async () => {
        if (opts.getCurrentDispatchedWorker && registered) {
          const currentWid = await opts.getCurrentDispatchedWorker(runId);
          if (currentWid !== null && currentWid !== registered.workerId) {
            // eslint-disable-next-line no-console
            console.warn(
              `[worker-rpc] dropped RunFailed from ${registered.workerId} for run ${runId}; current owner is ${currentWid}`,
            );
            return;
          }
        }
        settleRunCompletion(runId, err);
        opts.dispatcher.notifySettlement(runId, { kind: "failed", payload: err });
      })();
      return;
    }
    if (p.case === "runLeaseRenew") {
      // touchIfRun already reset the deadline above. Explicit case here
      // documents the keepalive contract and stops the no-op falling
      // through to "unknown frame" logging once we add it.
      return;
    }
    if (p.case === "serviceStatus") {
      // Plan 3: per-service status updates. Drop if the worker no
      // longer owns the run (Plan 2 Task 4 gate applies). Async, so
      // kick off without blocking subsequent frames.
      if (!opts.updateServiceStatus || !registered) return;
      const updateRow = opts.updateServiceStatus;
      const senderWorkerId = registered.workerId;
      const getOwner = opts.getCurrentDispatchedWorker;
      void handleServiceStatus(p.value, {
        senderWorkerId,
        getCurrentDispatchedWorker: getOwner ? (runId) => getOwner(runId) : async () => null,
        updateRow,
        onDrop: (input) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[worker-rpc] dropped ServiceStatus from ${input.sender} for run ${input.runId} svc ${input.runtimeServiceId}; current owner is ${input.currentOwner}`,
          );
        },
      }).catch(() => {
        /* updateRow logs internally in production */
      });
      return;
    }
    // Other variants (LeaseAck/Nack, RunLog, RunUsage, RunSession,
    // DrainRequested, Capacity) are handled in subsequent tasks.
  });
}
