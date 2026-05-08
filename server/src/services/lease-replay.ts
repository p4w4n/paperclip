// Decision logic for what happens when a run's lease expires (the
// reaper found it, fired notifySettlement, and now needs to decide:
// is this row a single dead worker or a poison run?). Spec NOTE N8:
// lease-expiry is the only signal that drives auto-replay, capped by
// maxAttempts; user-initiated retries take the retry_of_run_id path
// elsewhere.
//
// Pure decision function over (currentAttempts, maxAttempts) plus two
// effect callbacks. Tests pin the branching without DB or service
// internals; production wires requeue and markTerminal to Drizzle
// updates on heartbeat_runs.

export type LeaseReplayDecision = "requeued" | "terminal";

export interface HandleLeaseExpiryInput {
  runId: string;
  // Value of heartbeat_runs.attempts BEFORE this expiry. The row's
  // attempts column starts at 0 on first dispatch; the reaper-driven
  // re-queue increments it to 1 on the first expiry, 2 on the second,
  // and so on.
  currentAttempts: number;
  // Total attempts allowed including the original dispatch. Default in
  // production is 2 (one auto-replay after the first expiry); set to 1
  // to disable auto-replay entirely. Configurable via
  // WORKER_LEASE_MAX_ATTEMPTS env in server config.
  maxAttempts: number;
  requeue: (input: { runId: string; nextAttempts: number }) => Promise<void>;
  markTerminal: (input: {
    runId: string;
    finalAttempts: number;
    errorCode: "lease_expired_terminal";
  }) => Promise<void>;
}

export async function handleLeaseExpiry(input: HandleLeaseExpiryInput): Promise<LeaseReplayDecision> {
  const next = input.currentAttempts + 1;
  // `next >= maxAttempts` covers the "we've used up our retries" case
  // AND the defensive "row somehow has attempts past the cap" case
  // (manual DB edit, or maxAttempts lowered after a retried row was
  // already in flight). Either way we don't re-queue.
  if (next >= input.maxAttempts) {
    await input.markTerminal({
      runId: input.runId,
      finalAttempts: next,
      errorCode: "lease_expired_terminal",
    });
    return "terminal";
  }
  await input.requeue({ runId: input.runId, nextAttempts: next });
  return "requeued";
}
