// Plugin-SDK helper for the work queue. Plugin authors call
//   const result = await paperclip.workQueue.enqueue({ ... });
// and the SDK proxies through the host's REST surface.
//
// Plan 1 ships the wrapper that hits POST /api/companies/:cid/
// work-queue/:queue/items via the standard host-client. The
// dedupeKey gets surfaced on the Idempotency-Key header (Stripe
// shape) so the body schema doesn't need a dedupe field.

export type WorkQueueEnqueueInput = {
  companyId: string;
  queue?: string;
  priority?: number;
  dedupeKey?: string;
  targetIssueId?: string;
  targetAgentId?: string;
  routineId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  retryPolicy?: Record<string, unknown>;
  availableAt?: Date;
};

export interface WorkQueueEnqueueResult {
  enqueued: boolean;
  workItemId: string;
  reason?: "duplicate" | "queue_paused";
  existingId?: string;
}

export interface WorkQueueClient {
  enqueue(input: WorkQueueEnqueueInput): Promise<WorkQueueEnqueueResult>;
}

export interface CreateWorkQueueClientOpts {
  // The plugin host injects an authed fetch (sessions, agent JWT).
  // Falls back to globalThis.fetch with credentials='include' for
  // dev / browser embeds.
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createWorkQueueClient(opts: CreateWorkQueueClientOpts = {}): WorkQueueClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseUrl ?? "/api").replace(/\/+$/, "");
  return {
    async enqueue(input) {
      const queue = input.queue ?? "default";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (input.dedupeKey) headers["Idempotency-Key"] = input.dedupeKey;
      const body = JSON.stringify({
        priority: input.priority,
        targetIssueId: input.targetIssueId,
        targetAgentId: input.targetAgentId,
        routineId: input.routineId,
        payload: input.payload,
        maxAttempts: input.maxAttempts,
        retryPolicy: input.retryPolicy,
        availableAt: input.availableAt?.toISOString(),
      });
      const res = await fetchImpl(
        `${base}/companies/${encodeURIComponent(input.companyId)}/work-queue/${encodeURIComponent(queue)}/items`,
        {
          method: "POST",
          headers,
          body,
          credentials: "include",
        },
      );
      if (!res.ok) {
        throw new Error(`work-queue enqueue ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as WorkQueueEnqueueResult;
    },
  };
}
