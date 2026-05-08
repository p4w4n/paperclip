// Plan 4 workspace-lease reaper. Mirrors the run-lease reaper from
// Plan 2: a periodic sweep that flips workspace_leases rows whose
// expires_at has passed and whose released_at is still null. A worker
// dies → its run dies → its workspace lease eventually expires here
// → the partial unique index unblocks; the next dispatch on the same
// workspace can acquire fresh.
//
// Pure function — production wires findExpired to a Drizzle SELECT
// and release to an UPDATE. Per-row release errors are absorbed so
// one bad row doesn't freeze the sweep; a findExpired error
// propagates so the surrounding setInterval's logger.warn is loud.

export interface ExpiredWorkspaceLease {
  leaseId: string;
  projectWorkspaceId: string;
  expiresAt: Date;
}

export interface ReapWorkspaceLeasesDeps {
  now: () => Date;
  findExpired: () => Promise<ExpiredWorkspaceLease[]>;
  release: (input: { leaseId: string }) => Promise<void>;
}

export async function reapExpiredWorkspaceLeases(deps: ReapWorkspaceLeasesDeps): Promise<void> {
  // Snapshot now() once for determinism in tests; production
  // findExpired closes over the same value via its SQL.
  const snapshot = deps.now();
  void snapshot;
  const expired = await deps.findExpired();
  for (const row of expired) {
    try {
      await deps.release({ leaseId: row.leaseId });
    } catch {
      // One bad row doesn't freeze the sweep — next cycle re-includes
      // the row because its released_at is still null.
    }
  }
}
