// Worker-side process supervisor. Plan 3 splits the existing
// server/src/services/local-service-supervisor.ts execution layer onto
// the worker; this is the slim half — spawn / track / SIGTERM, no DB
// rows, no reuse cache, no orphan adoption. The control plane keeps
// the policy pieces (which services to start, lease accounting,
// per-row writes); the worker is where the actual processes run.
//
// What this DOES NOT do:
// - Persist anything. A worker death = process death; no
//   cross-restart recovery on the worker side.
// - Reuse processes across runs. Phase 4 (filestore mode) introduces
//   cross-worker reuse via a shared lease table; v3 each worker owns
//   its own service stack per-run.
// - Port detection / healthcheck. That layers on top in
//   services-runner.ts.

import { spawn, type ChildProcess } from "node:child_process";

export interface StartServiceInput {
  runId: string;
  runtimeServiceId: string;
  command: string;       // run via `/bin/sh -c <command>`
  cwd: string;
  env: Record<string, string>;
}

export interface ServiceHandle {
  runId: string;
  runtimeServiceId: string;
  pid: number;
  // Resolves on exit / error. The accessor `exitCode` becomes
  // populated synchronously once `closed` resolves; before that it's
  // null. Useful for the runner layer to distinguish "process crashed"
  // from "we asked it to stop".
  closed: Promise<void>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ServicesSupervisor {
  start(input: StartServiceInput): ServiceHandle;
  /**
   * Best-effort stop: SIGTERM, then SIGKILL after a short grace. Resolves
   * once the process is actually reaped.
   */
  stop(runtimeServiceId: string): Promise<void>;
  stopAllFor(runId: string): Promise<void>;
  stopAll(): Promise<void>;
  list(): ServiceHandle[];
}

interface InternalEntry extends ServiceHandle {
  child: ChildProcess;
}

const STOP_GRACE_MS = 5_000;

export function createServicesSupervisor(): ServicesSupervisor {
  const byId = new Map<string, InternalEntry>();

  const remove = (entry: InternalEntry): void => {
    const cur = byId.get(entry.runtimeServiceId);
    // Only remove if still us — re-uses of the same id (shouldn't
    // happen per-run, but defensive) won't clobber a fresh entry.
    if (cur === entry) byId.delete(entry.runtimeServiceId);
  };

  const start: ServicesSupervisor["start"] = (input) => {
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      // detached + stdio:"ignore" so a child that opens its own port
      // doesn't keep our event loop pinned via inherited stdio.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) {
      throw new Error(`failed to spawn service ${input.runtimeServiceId}: ${input.command}`);
    }
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    const entry: InternalEntry = {
      runId: input.runId,
      runtimeServiceId: input.runtimeServiceId,
      pid: child.pid,
      child,
      closed,
      exitCode: null,
      signal: null,
    };
    child.once("exit", (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      remove(entry);
      resolveClosed();
    });
    child.once("error", () => {
      // spawn-time error or post-spawn IO error; treat the same as
      // exit. Subsequent "exit" event will be a no-op (resolveClosed
      // is idempotent because Promise resolve is idempotent).
      remove(entry);
      resolveClosed();
    });
    // Drain stdout/stderr to /dev/null at the Node layer so the
    // pipes don't fill up and back-pressure the child.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    byId.set(input.runtimeServiceId, entry);
    return entry;
  };

  const stop: ServicesSupervisor["stop"] = async (runtimeServiceId) => {
    const entry = byId.get(runtimeServiceId);
    if (!entry) return;
    if (entry.exitCode !== null || entry.signal !== null) {
      // Already exited — `closed` is resolved or about to be.
      await entry.closed;
      return;
    }
    try {
      // Negative pid sends to the process group (since we spawned
      // detached). Catches misbehaving children that fork.
      process.kill(-entry.pid, "SIGTERM");
    } catch {
      // Race: process exited between our exitCode check and the kill;
      // closed will resolve on its own.
    }
    const escalate = setTimeout(() => {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS);
    if (typeof escalate.unref === "function") escalate.unref();
    await entry.closed;
    clearTimeout(escalate);
  };

  const stopAllFor: ServicesSupervisor["stopAllFor"] = async (runId) => {
    const ids = Array.from(byId.values())
      .filter((e) => e.runId === runId)
      .map((e) => e.runtimeServiceId);
    await Promise.all(ids.map((id) => stop(id)));
  };

  const stopAll: ServicesSupervisor["stopAll"] = async () => {
    const ids = Array.from(byId.keys());
    await Promise.all(ids.map((id) => stop(id)));
  };

  return {
    start,
    stop,
    stopAllFor,
    stopAll,
    list: () => Array.from(byId.values()),
  };
}
