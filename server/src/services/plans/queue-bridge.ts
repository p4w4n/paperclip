// Phase ↔ work-queue bridge.
//
// enqueuePhaseWork: produces a work_item carrying {planId, phaseId}
// in the payload + dedupeKey that includes the attempt count. The
// work-queue scheduler dequeues it; the routine-materializer (W-10)
// hits resolvePhaseTarget(planId, phaseId) which returns the
// (issueId, agentId) the run targets. plan_phase_runs is updated
// once the run id is known.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plans, planPhases, planPhaseRuns } from "@paperclipai/db";
import type { WorkQueueService } from "../work-queue/types.js";

export interface EnqueuePhaseWorkInput {
  planId: string;
  phaseId: string;
  // Override the queue. Default 'plan-phases' so admin observability
  // can split plan work from raw operator queues.
  queue?: string;
  // Override max attempts.
  maxAttempts?: number;
}

export async function enqueuePhaseWork(
  db: Db,
  workQueue: WorkQueueService,
  input: EnqueuePhaseWorkInput,
): Promise<{ workItemId: string; enqueued: boolean }> {
  const [phase] = await db
    .select()
    .from(planPhases)
    .where(eq(planPhases.id, input.phaseId));
  if (!phase) throw new Error("phase not found");
  const [plan] = await db.select().from(plans).where(eq(plans.id, phase.planId));
  if (!plan) throw new Error("plan not found");

  const result = await workQueue.enqueue(
    { callerCompanyId: plan.companyId },
    {
      companyId: plan.companyId,
      queue: input.queue ?? "plan-phases",
      // Attempts are bumped per-retry by the work-queue retry path,
      // not by the bridge — we use the phase id as the dedupeKey so
      // re-enqueue while the prior is still queued/running collapses.
      dedupeKey: `plan-${input.planId}-phase-${input.phaseId}`,
      targetIssueId: plan.issueId ?? undefined,
      targetAgentId: phase.assigneeAgentId ?? undefined,
      payload: {
        planContext: {
          planId: input.planId,
          phaseId: input.phaseId,
        },
      },
      maxAttempts: input.maxAttempts ?? 3,
      enqueuedByKind: "api",
      enqueuedByRef: `plan:${input.planId}`,
    },
  );
  return { workItemId: result.workItemId, enqueued: result.enqueued };
}

export async function recordPhaseRun(
  db: Db,
  phaseId: string,
  runId: string,
): Promise<void> {
  await db
    .insert(planPhaseRuns)
    .values({ phaseId, runId })
    .onConflictDoNothing();
}

// Dequeue side: the work-queue scheduler's routine-materializer
// looks for `payload.planContext` and calls this resolver to get
// the run target. The plan service is the source of truth.
export async function resolvePhaseTarget(
  db: Db,
  planContext: { planId: string; phaseId: string },
): Promise<{ issueId: string; agentId: string } | null> {
  const [phase] = await db
    .select({
      assigneeAgentId: planPhases.assigneeAgentId,
      planId: planPhases.planId,
    })
    .from(planPhases)
    .where(eq(planPhases.id, planContext.phaseId));
  if (!phase) return null;
  const [plan] = await db
    .select({ issueId: plans.issueId })
    .from(plans)
    .where(eq(plans.id, phase.planId));
  if (!plan?.issueId || !phase.assigneeAgentId) return null;
  return { issueId: plan.issueId, agentId: phase.assigneeAgentId };
}
