// Per spec NOTE N8: lease-expiry-driven failures auto-replay (increment
// attempts, transition the run back to queued) up to a configurable
// maxAttempts. User-initiated retries continue to use retry_of_run_id —
// separate code path, separate semantics.
//
// We test handleLeaseExpiry as a pure decision function so neither DB
// nor heartbeat-service internals are involved. The two side effects
// (requeue vs markTerminal) are passed in as callbacks; the function
// picks one.

import { describe, it, expect, vi } from "vitest";
import { handleLeaseExpiry } from "../lease-replay.js";

describe("handleLeaseExpiry", () => {
  it("re-queues with incremented attempts on first expiry", async () => {
    const requeue = vi.fn(async () => {});
    const markTerminal = vi.fn(async () => {});
    const decision = await handleLeaseExpiry({
      runId: "r1",
      currentAttempts: 0,
      maxAttempts: 2,
      requeue,
      markTerminal,
    });
    expect(decision).toBe("requeued");
    expect(requeue).toHaveBeenCalledWith({ runId: "r1", nextAttempts: 1 });
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("marks terminal when attempts already at the cap", async () => {
    const requeue = vi.fn(async () => {});
    const markTerminal = vi.fn(async () => {});
    // currentAttempts = 1, maxAttempts = 2 → next would be 2 which is
    // the cap; that's the second expiry, so terminal.
    const decision = await handleLeaseExpiry({
      runId: "r-terminal",
      currentAttempts: 1,
      maxAttempts: 2,
      requeue,
      markTerminal,
    });
    expect(decision).toBe("terminal");
    expect(markTerminal).toHaveBeenCalledWith({
      runId: "r-terminal",
      finalAttempts: 2,
      errorCode: "lease_expired_terminal",
    });
    expect(requeue).not.toHaveBeenCalled();
  });

  it("treats currentAttempts above the cap as terminal too (poison-run guard)", async () => {
    // Defensive: if a row somehow shows up with attempts already past
    // the cap (e.g., manual DB edit, or maxAttempts was lowered after
    // a row had already been retried), don't keep re-queuing it.
    const requeue = vi.fn(async () => {});
    const markTerminal = vi.fn(async () => {});
    const decision = await handleLeaseExpiry({
      runId: "r-stuck",
      currentAttempts: 5,
      maxAttempts: 2,
      requeue,
      markTerminal,
    });
    expect(decision).toBe("terminal");
    expect(markTerminal).toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
  });

  it("with maxAttempts=1 marks terminal on the first expiry (no replay)", async () => {
    // Useful for opt-out: setting WORKER_LEASE_MAX_ATTEMPTS=1 disables
    // auto-replay entirely, mirroring the pre-Plan-2 behavior.
    const requeue = vi.fn(async () => {});
    const markTerminal = vi.fn(async () => {});
    const decision = await handleLeaseExpiry({
      runId: "r-once",
      currentAttempts: 0,
      maxAttempts: 1,
      requeue,
      markTerminal,
    });
    expect(decision).toBe("terminal");
    expect(requeue).not.toHaveBeenCalled();
  });
});
