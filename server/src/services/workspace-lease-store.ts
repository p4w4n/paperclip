// Plan 4 lease store. Acquire = INSERT against the workspace_leases
// table; the partial unique index `WHERE released_at IS NULL` (added
// in 0083_workspace_leases.sql by hand) is the actual lock — Postgres
// rejects a second insert into the same project_workspace_id while
// the prior row is still held. We translate that 23505 unique
// violation into a "busy" return so callers don't have to know the
// pg-error-code shape.
//
// Renew = UPDATE expires_at WHERE released_at IS NULL — returns false
// if the lease has already been released or expired-and-reaped.
// Release = idempotent UPDATE setting released_at = now().

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workspaceLeases } from "@paperclipai/db";

export interface AcquireInput {
  projectWorkspaceId: string;
  runId: string | null;
  workerId: string | null;
  leaseSeconds: number;
}

export type AcquireResult =
  | { acquired: true; leaseId: string }
  | {
      acquired: false;
      reason: "busy";
      currentHolderRunId: string | null;
      currentHolderWorkerId: string | null;
    };

export interface RenewInput {
  leaseId: string;
  leaseSeconds: number;
}

export interface ReleaseInput {
  leaseId: string;
}

export interface WorkspaceLeaseStore {
  acquire(input: AcquireInput): Promise<AcquireResult>;
  renew(input: RenewInput): Promise<boolean>;
  release(input: ReleaseInput): Promise<void>;
}

interface PgUniqueViolation extends Error {
  code?: string;
  cause?: { code?: string };
}

// Postgres error code for unique-constraint violation is 23505;
// surface depends on the driver/wrapper. drizzle-orm with postgres-js
// surfaces it as a thrown Error with `.code = "23505"`.
function isUniqueViolation(err: unknown): boolean {
  const e = err as PgUniqueViolation | null;
  if (!e) return false;
  if (e.code === "23505") return true;
  if (e.cause && (e.cause as PgUniqueViolation).code === "23505") return true;
  return false;
}

export function createWorkspaceLeaseStore(db: Db): WorkspaceLeaseStore {
  return {
    async acquire(input) {
      const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000);
      try {
        const [row] = await db
          .insert(workspaceLeases)
          .values({
            projectWorkspaceId: input.projectWorkspaceId,
            heldByRunId: input.runId,
            heldByWorkerId: input.workerId,
            expiresAt,
          })
          .returning({ id: workspaceLeases.id });
        return { acquired: true, leaseId: row.id };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Look up the current holder for diagnostics. Best-effort —
        // a race between the violation and this select could return
        // empty; we return null fields in that case rather than
        // throwing.
        const [holder] = await db
          .select({
            runId: workspaceLeases.heldByRunId,
            workerId: workspaceLeases.heldByWorkerId,
          })
          .from(workspaceLeases)
          .where(
            and(
              eq(workspaceLeases.projectWorkspaceId, input.projectWorkspaceId),
              isNull(workspaceLeases.releasedAt),
            ),
          )
          .limit(1);
        return {
          acquired: false,
          reason: "busy",
          currentHolderRunId: holder?.runId ?? null,
          currentHolderWorkerId: holder?.workerId ?? null,
        };
      }
    },

    async renew(input) {
      const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000);
      const result = await db
        .update(workspaceLeases)
        .set({ expiresAt })
        .where(
          and(
            eq(workspaceLeases.id, input.leaseId),
            isNull(workspaceLeases.releasedAt),
          ),
        )
        // postgres-js + drizzle returns affected count via `.length`
        // on the returning() projection; we ask for id to keep the
        // query payload trivial.
        .returning({ id: workspaceLeases.id });
      return result.length > 0;
    },

    async release(input) {
      await db
        .update(workspaceLeases)
        .set({ releasedAt: sql`now()` })
        .where(
          and(
            eq(workspaceLeases.id, input.leaseId),
            isNull(workspaceLeases.releasedAt),
          ),
        );
    },
  };
}
