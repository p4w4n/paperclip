// Periodic sweep that settles in-flight runs whose lease deadline has
// passed. Lives outside the in-process RunDispatcher.leaseTimers so a
// control-plane restart still has a recovery path: every 30s, query
// heartbeat_runs for state=running AND lease_expires_at < now() and
// settle each one as lease_expired.
//
// Spec NOTE N8: lease-expiry is the only signal that drives auto-replay
// (Plan 2 Task 3). User-initiated retries take a different path
// (retry_of_run_id), so the reaper deliberately speaks only the
// lease_expired vocabulary here — the heartbeat service decides
// downstream whether to re-queue or mark terminally failed.
//
// Why a pure function (clock + finder + settler) instead of a class:
// the tests don't need DB or timers, and the production wire is a
// 4-line setInterval in server/src/index.ts. Keeping the reaper a
// single function makes both ends obvious.

export interface ExpiredRun {
  runId: string;
  // Whichever worker the row was last dispatched to. Forwarded into the
  // settle callback so the heartbeat service / connect-handler late-frame
  // gate can match against it (Plan 2 Task 4).
  workerId: string | null;
  leaseExpiresAt: Date;
  // Value of heartbeat_runs.attempts at the moment we found the row.
  // Settle (Plan 2 Task 3) compares against maxAttempts to decide
  // requeue vs terminal — keeping attempts in the projection saves a
  // per-row roundtrip in the production sweep.
  attempts: number;
}

export interface ReapDeps {
  now: () => Date;
  // Production wires this to a Drizzle select on heartbeat_runs:
  // state IN ('running', 'pending_run') AND lease_expires_at IS NOT NULL
  // AND lease_expires_at < now(). Tests stub a flat array.
  findExpired: () => Promise<ExpiredRun[]>;
  // Production fans this into runDispatcher.notifySettlement (so any
  // dispatch-or-local awaiter rejects) PLUS handleLeaseExpiry, which
  // increments attempts / re-queues vs marks terminal based on
  // maxAttempts.
  settle: (input: {
    runId: string;
    workerId: string | null;
    attempts: number;
    reason: "lease_expired";
  }) => Promise<void> | void;
}

export async function reapExpiredLeases(deps: ReapDeps): Promise<void> {
  // Snapshot the current wall-clock once so every row in this sweep
  // shares the same "now" — keeps the sweep deterministic and
  // testable. The actual `<` comparison happens inside findExpired
  // (production passes the snapshot into the SQL); we don't filter
  // again here.
  const snapshotNow = deps.now();
  void snapshotNow; // exposed-for-future-use; production findExpired closes over deps.now()

  const expired = await deps.findExpired();
  for (const row of expired) {
    try {
      await deps.settle({
        runId: row.runId,
        workerId: row.workerId,
        attempts: row.attempts,
        reason: "lease_expired",
      });
    } catch {
      // One bad row must not freeze the rest of the sweep — the next
      // cycle will retry the row anyway because findExpired returns it
      // again until the heartbeat service marks it settled. Swallow
      // here; the production settler logs.
    }
  }
}
