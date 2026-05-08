// Mirrors the run-lease reaper shape from Plan 2: pure function over
// (now, findExpired, releaseExpired) so neither DB nor timers are
// required for the unit. The production wiring's findExpired closure
// runs the SQL select; release flips released_at = now().

import { describe, it, expect, vi } from "vitest";
import { reapExpiredWorkspaceLeases, type ExpiredWorkspaceLease } from "../workspace-lease-reaper.js";

describe("reapExpiredWorkspaceLeases", () => {
  const now = () => new Date("2026-05-11T00:00:00Z");

  it("releases every lease whose expires_at has passed", async () => {
    const expired: ExpiredWorkspaceLease[] = [
      { leaseId: "l1", projectWorkspaceId: "w1", expiresAt: new Date("2026-05-10T23:59:00Z") },
      { leaseId: "l2", projectWorkspaceId: "w2", expiresAt: new Date("2026-05-10T23:50:00Z") },
    ];
    const release = vi.fn();
    await reapExpiredWorkspaceLeases({ now, findExpired: async () => expired, release });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith({ leaseId: "l1" });
    expect(release).toHaveBeenCalledWith({ leaseId: "l2" });
  });

  it("is a no-op when no leases are expired", async () => {
    const release = vi.fn();
    await reapExpiredWorkspaceLeases({ now, findExpired: async () => [], release });
    expect(release).not.toHaveBeenCalled();
  });

  it("absorbs per-row release errors so one bad row doesn't freeze the sweep", async () => {
    const expired: ExpiredWorkspaceLease[] = [
      { leaseId: "l-bad", projectWorkspaceId: "w1", expiresAt: new Date("2026-05-10T23:59:00Z") },
      { leaseId: "l-good", projectWorkspaceId: "w2", expiresAt: new Date("2026-05-10T23:59:00Z") },
    ];
    const release = vi.fn(async (input: { leaseId: string }) => {
      if (input.leaseId === "l-bad") throw new Error("boom");
    });
    await reapExpiredWorkspaceLeases({ now, findExpired: async () => expired, release });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("propagates a findExpired error so the surrounding setInterval logger.warn is loud", async () => {
    const release = vi.fn();
    await expect(
      reapExpiredWorkspaceLeases({
        now,
        findExpired: async () => {
          throw new Error("db unavailable");
        },
        release,
      }),
    ).rejects.toThrow(/db unavailable/);
    expect(release).not.toHaveBeenCalled();
  });
});
