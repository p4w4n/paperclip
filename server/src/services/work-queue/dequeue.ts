// Per-company dequeue helper. The scheduler walks companies in
// fairness order (W-5) and calls dequeueOneForCompany inside the
// loop. The hot SELECT uses FOR UPDATE SKIP LOCKED so concurrent
// scheduler ticks don't race on the same row — same primitive as
// workspace_leases (Plan 4 of distributed-workers).
//
// State transition (queued → running) is the caller's job; this
// helper just locks the next row + returns it. Caller is expected
// to UPDATE inside the same transaction.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { WorkItem, WorkItemState } from "./types.js";

export interface DequeueInput {
  db: Db;
  companyId: string;
  queue: string;
  now?: Date;
}

interface RawWorkItemRow {
  id: string;
  company_id: string;
  queue: string;
  priority: number;
  dedupe_key: string | null;
  target_issue_id: string | null;
  target_agent_id: string | null;
  routine_id: string | null;
  payload: Record<string, unknown> | null;
  state: string;
  available_at: Date;
  attempts: number;
  max_attempts: number;
  retry_policy: Record<string, unknown> | null;
  enqueued_by_kind: string;
  enqueued_by_ref: string | null;
  enqueued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  run_id: string | null;
  last_error: string | null;
  last_error_code: string | null;
}

export async function dequeueOneForCompany(input: DequeueInput): Promise<WorkItem | null> {
  const now = input.now ?? new Date();
  // Raw SQL — Drizzle doesn't expose FOR UPDATE SKIP LOCKED on
  // .select() builder; the spec calls this out explicitly.
  const result = await input.db.execute(sql`
    SELECT * FROM work_items
    WHERE company_id = ${input.companyId}
      AND queue = ${input.queue}
      AND state = 'queued'
      AND available_at <= ${now}
    ORDER BY priority DESC, available_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);
  // postgres-driver returns { rows: [...] } in the @paperclipai/db
  // shape; some test mocks return [...] directly. Handle both.
  const rows = (Array.isArray(result)
    ? result
    : (result as { rows?: RawWorkItemRow[] }).rows ?? []) as RawWorkItemRow[];
  if (rows.length === 0) return null;
  return rawToWorkItem(rows[0]);
}

function rawToWorkItem(r: RawWorkItemRow): WorkItem {
  return {
    id: r.id,
    companyId: r.company_id,
    queue: r.queue,
    priority: r.priority,
    dedupeKey: r.dedupe_key,
    targetIssueId: r.target_issue_id,
    targetAgentId: r.target_agent_id,
    routineId: r.routine_id,
    payload: r.payload,
    state: r.state as WorkItemState,
    availableAt: r.available_at instanceof Date ? r.available_at : new Date(r.available_at),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    retryPolicy: r.retry_policy as WorkItem["retryPolicy"],
    enqueuedByKind: r.enqueued_by_kind as WorkItem["enqueuedByKind"],
    enqueuedByRef: r.enqueued_by_ref,
    enqueuedAt: r.enqueued_at instanceof Date ? r.enqueued_at : new Date(r.enqueued_at),
    startedAt: r.started_at ? new Date(r.started_at) : null,
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    runId: r.run_id,
    lastError: r.last_error,
    lastErrorCode: r.last_error_code,
  };
}
