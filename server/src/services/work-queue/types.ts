// Plugin contract for the WorkQueueService. The default
// implementation (service.ts) is in-process; the same shape is
// what a future plugin would provide.
//
// Tenant isolation runs at the service layer — every input carries
// companyId; assertTenant rejects cross-company calls before any
// side effect.

export type WorkItemState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type EnqueuedByKind = "webhook" | "routine" | "api" | "human";

export type RetryClass =
  | "transient_provider"
  | "transient_local"
  | "poison"
  | "quota_exceeded"
  | "permanent";

export interface RetryPolicy {
  // Override per-class behavior. Each value is interpreted by
  // applyRetryPolicy. Missing keys fall back to defaults.
  on_429?: string;
  on_5xx?: string;
  on_lease_expired?: string;
  on_poison?: "dead_letter" | "discard";
  // Backoff cap in ms.
  backoff_cap_ms?: number;
  // Override max attempts.
  max_attempts?: number;
}

export type RetryDecision =
  | { kind: "retry"; availableAt: Date; attempts: number }
  | { kind: "dead_letter"; reason: string }
  | { kind: "discard" };

export interface WorkQueueServiceContext {
  callerCompanyId: string;
}

export interface EnqueueInput {
  companyId: string;
  queue?: string;
  priority?: number;
  dedupeKey?: string;
  targetIssueId?: string;
  targetAgentId?: string;
  routineId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  availableAt?: Date;
  enqueuedByKind: EnqueuedByKind;
  enqueuedByRef?: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  workItemId: string;
  reason?: "duplicate" | "queue_paused";
  existingId?: string;
}

export interface WorkItem {
  id: string;
  companyId: string;
  queue: string;
  priority: number;
  dedupeKey: string | null;
  targetIssueId: string | null;
  targetAgentId: string | null;
  routineId: string | null;
  payload: Record<string, unknown> | null;
  state: WorkItemState;
  availableAt: Date;
  attempts: number;
  maxAttempts: number;
  retryPolicy: RetryPolicy | null;
  enqueuedByKind: EnqueuedByKind;
  enqueuedByRef: string | null;
  enqueuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  runId: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
}

export interface WorkQueueService {
  enqueue(ctx: WorkQueueServiceContext, input: EnqueueInput): Promise<EnqueueResult>;
  cancel(
    ctx: WorkQueueServiceContext,
    input: { id: string; companyId: string },
  ): Promise<void>;
  replayDeadLetter(
    ctx: WorkQueueServiceContext,
    input: { id: string; companyId: string; resetAttempts?: boolean },
  ): Promise<void>;
  list(
    ctx: WorkQueueServiceContext,
    input: { companyId: string; queue?: string; state?: WorkItemState; limit?: number },
  ): Promise<WorkItem[]>;
  getDepth(
    ctx: WorkQueueServiceContext,
    input: { companyId: string; queue?: string },
  ): Promise<number>;
}

export class WorkQueueTenantMismatchError extends Error {
  constructor(callerCompanyId: string, inputCompanyId: string) {
    super(
      `work_queue tenant mismatch: caller company ${callerCompanyId} does not match input ${inputCompanyId}`,
    );
    this.name = "WorkQueueTenantMismatchError";
  }
}
