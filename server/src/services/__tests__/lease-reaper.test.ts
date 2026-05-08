// The lease reaper is the recovery oracle for runs whose in-memory
// lease timer was lost (control-plane restart) or never fired (worker
// died and the lease ran out without a settle frame). Tests pin the
// pure shape — clock + finder + settler — so neither the DB nor real
// timers are involved.

import { describe, it, expect, vi } from "vitest";
import { reapExpiredLeases, type ExpiredRun } from "../lease-reaper.js";

describe("reapExpiredLeases", () => {
  const now = () => new Date("2026-05-09T00:00:00Z");

  it("settles every run whose lease deadline has passed", async () => {
    const expired: ExpiredRun[] = [
      { runId: "r1", workerId: "w-dead", leaseExpiresAt: new Date("2026-05-08T23:59:00Z") },
      { runId: "r2", workerId: "w-dead-2", leaseExpiresAt: new Date("2026-05-08T23:50:00Z") },
    ];
    const settle = vi.fn();
    await reapExpiredLeases({ now, findExpired: async () => expired, settle });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith({ runId: "r1", workerId: "w-dead", reason: "lease_expired" });
    expect(settle).toHaveBeenCalledWith({ runId: "r2", workerId: "w-dead-2", reason: "lease_expired" });
  });

  it("is a no-op when no runs are expired", async () => {
    const settle = vi.fn();
    await reapExpiredLeases({ now, findExpired: async () => [], settle });
    expect(settle).not.toHaveBeenCalled();
  });

  it("continues settling remaining runs if one settle throws", async () => {
    // Production settler may throw (e.g., notifySettlement listener bug).
    // The reaper must not let one bad row freeze the whole sweep.
    const expired: ExpiredRun[] = [
      { runId: "r-bad", workerId: "w1", leaseExpiresAt: new Date("2026-05-08T23:59:00Z") },
      { runId: "r-good", workerId: "w2", leaseExpiresAt: new Date("2026-05-08T23:59:00Z") },
    ];
    const settle = vi.fn(async (input: { runId: string }) => {
      if (input.runId === "r-bad") throw new Error("boom");
    });
    await reapExpiredLeases({ now, findExpired: async () => expired, settle });
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("propagates a findExpired error (boot misconfiguration / DB outage)", async () => {
    // Distinct from per-row settle failures: if findExpired itself can't
    // run (DB down, schema mismatch), we want the surrounding setInterval
    // to log the error visibly rather than silently no-op every cycle.
    const settle = vi.fn();
    await expect(
      reapExpiredLeases({
        now,
        findExpired: async () => {
          throw new Error("db unavailable");
        },
        settle,
      }),
    ).rejects.toThrow(/db unavailable/);
    expect(settle).not.toHaveBeenCalled();
  });
});
