// services-runner sits above services-supervisor: given a list of
// RuntimeServiceSpec, it spawns each via the supervisor, polls
// readiness, and reports state transitions back via the injected
// `send` callback. Rollback semantics: if any service fails to become
// ready, all already-started services for that run get stopped before
// startAll rejects.
//
// Pure-ish — no real network, no real spawn — both are injected via
// `supervisor` and `probe` so the unit tests don't need a port
// listener or child process.

import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServiceStatusSchema,
  type RuntimeServiceSpec,
  type WorkerToServer,
} from "@paperclipai/worker-rpc";
import * as net from "node:net";

export interface SupervisedHandle {
  runId: string;
  runtimeServiceId: string;
  pid: number;
  closed: Promise<void>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ServicesSupervisorLike {
  start(input: {
    runId: string;
    runtimeServiceId: string;
    command: string;
    cwd: string;
    env: Record<string, string>;
  }): SupervisedHandle;
  stopAllFor(runId: string): Promise<void>;
}

export type ProbeFn = (spec: RuntimeServiceSpec) => Promise<boolean>;

export interface ServicesRunnerOpts {
  supervisor: ServicesSupervisorLike;
  // Production probe: TCP-connect for ready_port, fetch() for healthcheck;
  // returns true once the service is reachable. Tests stub this so no
  // network is involved.
  probe: ProbeFn;
  // Production: bidi send through the connect loop's
  // WorkerClientHandle.send. Tests collect into an array.
  send: (msg: WorkerToServer) => Promise<void>;
  // Default 250ms — tests pass smaller for fast assertions.
  probeIntervalMs?: number;
}

export interface ServicesRunner {
  startAll(runId: string, specs: RuntimeServiceSpec[]): Promise<void>;
  stopAllFor(runId: string): Promise<void>;
}

export function createServicesRunner(opts: ServicesRunnerOpts): ServicesRunner {
  const probeIntervalMs = opts.probeIntervalMs ?? 250;

  const emitStatus = async (
    runId: string,
    spec: RuntimeServiceSpec,
    state: "starting" | "running" | "failed" | "stopped",
    extras: { pid?: number; boundPort?: number; url?: string; error?: string; errorCode?: string } = {},
  ): Promise<void> => {
    await opts.send(
      create(WorkerToServerSchema, {
        payload: {
          case: "serviceStatus",
          value: create(ServiceStatusSchema, {
            runId,
            runtimeServiceId: spec.runtimeServiceId,
            state,
            pid: extras.pid ?? 0,
            boundPort: extras.boundPort ?? 0,
            url: extras.url ?? "",
            error: extras.error ?? "",
            errorCode: extras.errorCode ?? "",
          }),
        },
      }),
    );
  };

  const startOne = async (runId: string, spec: RuntimeServiceSpec): Promise<void> => {
    await emitStatus(runId, spec, "starting");
    let handle: SupervisedHandle;
    try {
      handle = opts.supervisor.start({
        runId,
        runtimeServiceId: spec.runtimeServiceId,
        command: spec.command,
        cwd: spec.cwd,
        env: { ...spec.env },
      });
    } catch (err) {
      await emitStatus(runId, spec, "failed", {
        error: (err as Error).message,
        errorCode: "service_spawn_failed",
      });
      throw err;
    }

    // PID-only readiness — no port, no healthcheck.
    if (!spec.readyPort && !spec.readyHealthcheckUrl) {
      await emitStatus(runId, spec, "running", { pid: handle.pid });
      return;
    }

    // Probe loop. Bounded by readiness_timeout_sec (default 60s).
    const timeoutMs = (spec.readinessTimeoutSec || 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      let ready = false;
      try {
        ready = await opts.probe(spec);
      } catch {
        ready = false;
      }
      if (ready) {
        await emitStatus(runId, spec, "running", {
          pid: handle.pid,
          boundPort: spec.readyPort || 0,
          url: spec.readyHealthcheckUrl,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, probeIntervalMs));
    }
    const err = new Error(`readiness timeout for service ${spec.serviceName}`);
    await emitStatus(runId, spec, "failed", {
      pid: handle.pid,
      error: err.message,
      errorCode: "readiness_timeout",
    });
    throw err;
  };

  return {
    async startAll(runId, specs) {
      // Sequential, not parallel — services often have ordering
      // dependencies (db before app). Caller can sequence the spec
      // list however they want; we honor that order.
      try {
        for (const spec of specs) {
          await startOne(runId, spec);
        }
      } catch (err) {
        // Rollback: stop everything we started for this run before
        // rejecting. The startOne path already emitted "failed" for
        // the offending service.
        await opts.supervisor.stopAllFor(runId);
        throw err;
      }
    },
    stopAllFor(runId) {
      return opts.supervisor.stopAllFor(runId);
    },
  };
}

// Default production probe: TCP-connect the bound port, or fetch()
// the healthcheck URL. Used by packages/worker/src/index.ts; tests
// inject their own probe.
export function defaultProbe(): ProbeFn {
  return async (spec) => {
    if (spec.readyHealthcheckUrl) {
      try {
        const res = await fetch(spec.readyHealthcheckUrl);
        return res.ok;
      } catch {
        return false;
      }
    }
    if (spec.readyPort) {
      return new Promise<boolean>((resolve) => {
        const sock = net.connect({ port: spec.readyPort, host: "127.0.0.1" }, () => {
          sock.end();
          resolve(true);
        });
        sock.once("error", () => resolve(false));
      });
    }
    return true;
  };
}
