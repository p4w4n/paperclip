// Materialization: convert a locked work_item into a heartbeat_run.
//
// Two paths:
//   - Pre-resolved (target_issue_id + target_agent_id set): the
//     scheduler inserts a heartbeat_runs row directly with a
//     'wakeupSource = work_queue' marker so the existing dispatcher
//     picks it up.
//   - Routine-driven (routine_id set): the scheduler calls back
//     into the routine's materialize() to produce the issue+run
//     target. Routine integration lands in W-10.
//
// In both cases this helper performs the work_items state
// transition (queued → running) and increments
// work_queue_tenant_credits.recent_dequeued atomically inside
// the same transaction.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, workItems, workQueueTenantCredits } from "@paperclipai/db";
import type { WorkItem } from "./types.js";

export interface MaterializeOpts {
  // The locked work_item (returned by dequeueOneForCompany).
  item: WorkItem;
  // Resolves a routine_id-driven item into the (issueId, agentId)
  // pair the run will run on. Implementation lands with W-10.
  resolveRoutineTarget?: (
    routineId: string,
    payload: Record<string, unknown> | null,
  ) => Promise<{ issueId: string; agentId: string } | null>;
}

export interface MaterializeResult {
  runId: string;
}

export async function materializeWorkItem(
  db: Db,
  opts: MaterializeOpts,
): Promise<MaterializeResult> {
  const { item } = opts;
  return db.transaction(async (tx) => {
    let issueId: string | null = item.targetIssueId;
    let agentId: string | null = item.targetAgentId;
    if (!issueId || !agentId) {
      if (item.routineId && opts.resolveRoutineTarget) {
        const resolved = await opts.resolveRoutineTarget(item.routineId, item.payload);
        if (!resolved) {
          throw new Error(
            `materializeWorkItem: routine ${item.routineId} did not resolve a target`,
          );
        }
        issueId = resolved.issueId;
        agentId = resolved.agentId;
      } else {
        throw new Error(
          "materializeWorkItem: work_item has neither (issue,agent) nor a resolved routine target",
        );
      }
    }

    const now = new Date();
    const [run] = await tx
      .insert(heartbeatRuns)
      .values({
        companyId: item.companyId,
        agentId: agentId!,
        invocationSource: "work_queue",
        triggerDetail: item.queue,
        status: "queued",
        contextSnapshot: {
          issueId,
          workItemId: item.id,
          workQueuePayload: item.payload ?? null,
        } as Record<string, unknown>,
      })
      .returning({ id: heartbeatRuns.id });

    await tx
      .update(workItems)
      .set({
        state: "running",
        startedAt: now,
        runId: run.id,
        attempts: item.attempts + 1,
      })
      .where(eq(workItems.id, item.id));

    // Bump fairness counter; UPSERT so a freshly-active company
    // doesn't need a pre-seeded credits row.
    await tx
      .insert(workQueueTenantCredits)
      .values({ companyId: item.companyId, recentDequeued: 1 })
      .onConflictDoUpdate({
        target: workQueueTenantCredits.companyId,
        set: {
          recentDequeued: sql`${workQueueTenantCredits.recentDequeued} + 1`,
          updatedAt: now,
        },
      });

    return { runId: run.id };
  });
}
