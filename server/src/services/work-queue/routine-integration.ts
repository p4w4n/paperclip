// Routine ↔ work queue integration glue.
//
// Two surfaces:
//   1. shouldEnqueueViaWorkQueue(routine) — pure check on the
//      routine's enqueue_via_work_queue flag. Lets the routine-
//      trigger code switch between direct materialize() and the
//      enqueue path without hard-wiring either.
//   2. enqueueRoutineFiring(svc, routine, payload) — calls
//      WorkQueueService.enqueue with routine_id set, propagating
//      the routine's default_retry_policy if present.
//
// Routine-target resolution (the dequeue side) lives in
// resolveRoutineTargetFor(); the scheduler in W-12 passes it as
// the resolveRoutineTarget callback to materializeWorkItem.

import type {
  EnqueueResult,
  WorkQueueService,
  WorkQueueServiceContext,
} from "./types.js";

export interface RoutineForEnqueue {
  id: string;
  companyId: string;
  enqueueViaWorkQueue: boolean;
  defaultRetryPolicy: Record<string, unknown> | null;
  assigneeAgentId: string | null;
}

export function shouldEnqueueViaWorkQueue(routine: RoutineForEnqueue): boolean {
  return routine.enqueueViaWorkQueue === true;
}

export interface EnqueueRoutineFiringInput {
  routine: RoutineForEnqueue;
  payload?: Record<string, unknown>;
  // Stripe-style idempotency key (e.g., from the trigger's
  // computed-uniqueness key). Optional — when absent the queue
  // accepts duplicate firings.
  dedupeKey?: string;
  // Override the routine's default policy.
  retryPolicyOverride?: Record<string, unknown>;
  // The actor that caused the routine to fire (system / user / agent).
  enqueuedByRef?: string;
}

export async function enqueueRoutineFiring(
  svc: WorkQueueService,
  ctx: WorkQueueServiceContext,
  input: EnqueueRoutineFiringInput,
): Promise<EnqueueResult> {
  return svc.enqueue(ctx, {
    companyId: input.routine.companyId,
    routineId: input.routine.id,
    targetAgentId: input.routine.assigneeAgentId ?? undefined,
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    retryPolicy:
      (input.retryPolicyOverride ?? input.routine.defaultRetryPolicy) ?? undefined,
    enqueuedByKind: "routine",
    enqueuedByRef: input.enqueuedByRef ?? input.routine.id,
  });
}

// Dequeue-side: resolve a routine_id (set on a work_item) into the
// (issueId, agentId) the scheduler needs to materialize a run.
// In Plan 1 the routine's existing materialize() is the source of
// truth — this thin shim lets the scheduler call it without
// knowing the routines module's internals. Wiring lands in the
// scheduler glue (W-12) where the actual routine service is in
// scope.
export interface RoutineMaterializeFn {
  (
    routineId: string,
    payload: Record<string, unknown> | null,
  ): Promise<{ issueId: string; agentId: string } | null>;
}

let routineMaterializer: RoutineMaterializeFn | null = null;

export function registerRoutineMaterializer(fn: RoutineMaterializeFn): void {
  routineMaterializer = fn;
}

export function getRoutineMaterializer(): RoutineMaterializeFn {
  if (!routineMaterializer) {
    throw new Error(
      "routine materializer not registered — call registerRoutineMaterializer at boot",
    );
  }
  return routineMaterializer;
}
