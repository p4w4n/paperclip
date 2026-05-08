// Plan 5: graceful control-plane shutdown. SIGTERM → drainAllWorkers
// sends Drain to every connected worker, waits for stream-end (via
// the registry's unregister hook), caps the wait so a stuck worker
// doesn't block process exit. Workers that don't drain in time get
// orphaned at the gRPC level — they reconnect to the next control
// plane cycle and the lease reaper from Plan 2 cleans up any
// in-flight runs they were holding.

export interface DrainAllDeps {
  list: () => Array<{ workerId: string }>;
  requestDrain: (workerId: string) => Promise<boolean>;
  // Resolves when the worker has unregistered (stream closed). Tests
  // pass a stub; production wires the registry's stream-end event.
  waitForUnregister: (workerId: string) => Promise<void>;
  gracePeriodMs: number;
}

export async function drainAllWorkers(deps: DrainAllDeps): Promise<void> {
  const workers = deps.list();
  if (workers.length === 0) return;
  // Fire all drains in parallel; each worker times out independently
  // against gracePeriodMs so one stuck instance can't extend the
  // others' wait.
  await Promise.all(
    workers.map(async (w) => {
      await deps.requestDrain(w.workerId);
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, deps.gracePeriodMs);
        if (typeof t.unref === "function") t.unref();
      });
      await Promise.race([deps.waitForUnregister(w.workerId), timeout]);
    }),
  );
}
