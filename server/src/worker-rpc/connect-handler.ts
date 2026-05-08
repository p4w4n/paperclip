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

// gRPC keepalive guarantees the *transport* is alive; the application Ping
// is a separate channel that proves the *application* is responsive (proto
// frames flowing, not just TCP packets).
const PING_INTERVAL_MS = 15_000;
const PONG_DEADLINE_MS = 60_000;

export async function handleConnect(
  call: grpc.ServerDuplexStream<WorkerToServer, ServerToWorker>,
  opts: { auth: WorkerAuthStrategy; registry: WorkerRegistry },
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

  call.on("data", (msg: WorkerToServer) => {
    lastSeen = Date.now();
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
      // slot via dispatcher.markCompleted.
      settleRunCompletion(p.value.runId, {
        exitCode: p.value.exitCode,
        signal: p.value.signal || null,
        timedOut: false,
        summary: p.value.summary,
      });
      return;
    }
    if (p.case === "runFailed") {
      settleRunCompletion(
        p.value.runId,
        new Error(p.value.error || `run failed (${p.value.errorCode || "unknown"})`),
      );
      return;
    }
    // Other variants (LeaseAck/Nack, RunLog, RunUsage, RunSession,
    // RunLeaseRenew, DrainRequested, Capacity) are handled in
    // subsequent tasks.
  });
}
