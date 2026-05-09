// Default in-process WorkQueueService.
//
// enqueue() flow:
//   1. assertTenant — caller's company must match input.scope.
//   2. validate priority + at-least-one-target.
//   3. INSERT … ON CONFLICT DO NOTHING — the partial unique on
//      (company_id, dedupe_key) WHERE state IN ('queued','running')
//      absorbs duplicates.
//   4. If RETURNING is empty → SELECT the existing active row and
//      return {enqueued: false, reason: 'duplicate', existingId}.
//
// cancel / replayDeadLetter / list / getDepth land in W-9.

import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workItems } from "@paperclipai/db";
import {
  WorkQueueTenantMismatchError,
  type EnqueueInput,
  type EnqueueResult,
  type WorkItem,
  type WorkItemState,
  type WorkQueueService,
  type WorkQueueServiceContext,
} from "./types.js";

export interface WorkQueueServiceOpts {
  db: Db;
}

export function createWorkQueueService(opts: WorkQueueServiceOpts): WorkQueueService {
  function assertTenant(ctx: WorkQueueServiceContext, companyId: string): void {
    if (ctx.callerCompanyId !== companyId) {
      throw new WorkQueueTenantMismatchError(ctx.callerCompanyId, companyId);
    }
  }

  return {
    async enqueue(ctx, input) {
      assertTenant(ctx, input.companyId);
      const priority = input.priority ?? 5;
      if (priority < 0 || priority > 9) {
        throw new Error(`priority must be 0..9; got ${priority}`);
      }
      if (!input.targetIssueId && !input.targetAgentId && !input.routineId) {
        throw new Error(
          "enqueue requires at least one of targetIssueId, targetAgentId, routineId",
        );
      }
      const queue = input.queue ?? "default";
      const availableAt = input.availableAt ?? new Date();
      const maxAttempts = input.maxAttempts ?? 3;

      const inserted = await opts.db
        .insert(workItems)
        .values({
          companyId: input.companyId,
          queue,
          priority,
          dedupeKey: input.dedupeKey ?? null,
          targetIssueId: input.targetIssueId ?? null,
          targetAgentId: input.targetAgentId ?? null,
          routineId: input.routineId ?? null,
          payload: (input.payload ?? null) as Record<string, unknown> | null,
          availableAt,
          maxAttempts,
          retryPolicy:
            (input.retryPolicy as Record<string, unknown> | undefined) ?? null,
          enqueuedByKind: input.enqueuedByKind,
          enqueuedByRef: input.enqueuedByRef ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: workItems.id });

      if (inserted.length > 0) {
        return { enqueued: true, workItemId: inserted[0].id };
      }

      // Conflict path — find the active duplicate.
      if (!input.dedupeKey) {
        // No dedupe key + no insert means a different conflict
        // (shouldn't happen with current schema but be explicit).
        throw new Error("enqueue failed unexpectedly with no dedupe_key");
      }
      const [existing] = await opts.db
        .select({ id: workItems.id })
        .from(workItems)
        .where(
          and(
            eq(workItems.companyId, input.companyId),
            eq(workItems.dedupeKey, input.dedupeKey),
            sql`${workItems.state} IN ('queued','running')`,
          ),
        )
        .limit(1);

      return {
        enqueued: false,
        workItemId: existing?.id ?? "",
        reason: "duplicate",
        existingId: existing?.id,
      };
    },

    async cancel(ctx, input) {
      assertTenant(ctx, input.companyId);
      await opts.db
        .update(workItems)
        .set({ state: "cancelled", completedAt: new Date() })
        .where(
          and(
            eq(workItems.id, input.id),
            eq(workItems.companyId, input.companyId),
            sql`${workItems.state} IN ('queued','running')`,
          ),
        );
    },

    async replayDeadLetter(ctx, input) {
      assertTenant(ctx, input.companyId);
      const resetAttempts = input.resetAttempts ?? true;
      await opts.db
        .update(workItems)
        .set({
          state: "queued",
          attempts: resetAttempts ? 0 : sql`${workItems.attempts}` as unknown as number,
          completedAt: null,
          availableAt: new Date(),
          lastError: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(workItems.id, input.id),
            eq(workItems.companyId, input.companyId),
            eq(workItems.state, "dead_letter"),
          ),
        );
    },

    async list(ctx, input) {
      assertTenant(ctx, input.companyId);
      const limit = input.limit ?? 100;
      const filters = [eq(workItems.companyId, input.companyId)];
      if (input.queue) filters.push(eq(workItems.queue, input.queue));
      if (input.state) filters.push(eq(workItems.state, input.state));
      const rows = await opts.db
        .select()
        .from(workItems)
        .where(and(...filters))
        .orderBy(desc(workItems.enqueuedAt))
        .limit(limit);
      return rows.map(rowToWorkItem);
    },

    async getDepth(ctx, input) {
      assertTenant(ctx, input.companyId);
      const filters = [
        eq(workItems.companyId, input.companyId),
        eq(workItems.state, "queued"),
      ];
      if (input.queue) filters.push(eq(workItems.queue, input.queue));
      const [row] = await opts.db
        .select({ n: count() })
        .from(workItems)
        .where(and(...filters));
      return Number(row?.n ?? 0);
    },
  };
}

function rowToWorkItem(row: typeof workItems.$inferSelect): WorkItem {
  return {
    id: row.id,
    companyId: row.companyId,
    queue: row.queue,
    priority: row.priority,
    dedupeKey: row.dedupeKey,
    targetIssueId: row.targetIssueId,
    targetAgentId: row.targetAgentId,
    routineId: row.routineId,
    payload: row.payload,
    state: row.state as WorkItemState,
    availableAt: row.availableAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    retryPolicy: row.retryPolicy as WorkItem["retryPolicy"],
    enqueuedByKind: row.enqueuedByKind as WorkItem["enqueuedByKind"],
    enqueuedByRef: row.enqueuedByRef,
    enqueuedAt: row.enqueuedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    runId: row.runId,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
  };
}

let singleton: WorkQueueService | null = null;
export function initializeWorkQueueService(opts: WorkQueueServiceOpts): WorkQueueService {
  singleton = createWorkQueueService(opts);
  return singleton;
}
export function getWorkQueueService(): WorkQueueService {
  if (!singleton) {
    throw new Error("WorkQueueService not initialized — call initializeWorkQueueService(...) at boot");
  }
  return singleton;
}

// Used by W-9 dead-letter test and by W-15 metrics; suppress
// unused-import warning in this file since we re-export below.
export { isNotNull };
