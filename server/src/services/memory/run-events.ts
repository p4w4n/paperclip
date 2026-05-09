// Helper that converts a run-lifecycle event into a memory.write
// call. Plan 1 of Memory: every run boundary (start, finish, comment
// arrived) writes an episodic entry so the system has a baseline
// signal without the agent doing anything.
//
// Wiring into heartbeat.ts is deferred — heartbeat.ts has multiple
// run-insert + completion paths; clean integration belongs in a
// dedicated heartbeat refactor. Same pattern as workers P5-7
// (session-blob redirect): helpers + tests ship; the integration
// site lands when the surrounding code is ready.
//
// Failure mode: every call here is fire-and-forget. A memory.write
// failure logs but does NOT stall the run path. That matches the
// spec ("Write failures are logged but do not stall the run path").

import type { MemoryService, MemoryServiceContext } from "./service.js";

export interface RunStartEvent {
  runId: string;
  companyId: string;
  agentId?: string;
  issueId?: string;
  issueTitle?: string;
}

export interface RunFinishEvent {
  runId: string;
  companyId: string;
  agentId?: string;
  issueId?: string;
  exitCode: number;
  summary?: string;
}

export interface RunCommentEvent {
  runId: string;
  companyId: string;
  agentId?: string;
  issueId?: string;
  commentBy: string;
  commentExcerpt: string;
}

/**
 * Synchronous wrapper that fires `memory.write` and never throws —
 * suitable for call sites that must not be blocked by memory.
 */
function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[memory.run-events] ${context} write failed`, err);
  });
}

export function recordRunStart(svc: MemoryService, event: RunStartEvent): void {
  const ctx: MemoryServiceContext = { callerCompanyId: event.companyId };
  const content = event.issueTitle
    ? `Run started for issue '${event.issueTitle}'`
    : `Run ${event.runId} started`;
  fireAndForget(
    svc.write(ctx, {
      scope: {
        companyId: event.companyId,
        agentId: event.agentId,
        sessionId: event.issueId ?? event.runId,
        sessionKind: event.issueId ? "issue" : "run",
      },
      kind: "episodic",
      content,
      sourceRunId: event.runId,
    }),
    "run.start",
  );
}

export function recordRunFinish(svc: MemoryService, event: RunFinishEvent): void {
  const ctx: MemoryServiceContext = { callerCompanyId: event.companyId };
  const content = event.summary
    ? `Run finished (exit ${event.exitCode}): ${event.summary}`
    : `Run finished (exit ${event.exitCode})`;
  fireAndForget(
    svc.write(ctx, {
      scope: {
        companyId: event.companyId,
        agentId: event.agentId,
        sessionId: event.issueId ?? event.runId,
        sessionKind: event.issueId ? "issue" : "run",
      },
      kind: "episodic",
      content,
      sourceRunId: event.runId,
    }),
    "run.finish",
  );
}

export function recordRunComment(svc: MemoryService, event: RunCommentEvent): void {
  const ctx: MemoryServiceContext = { callerCompanyId: event.companyId };
  // Trim the excerpt so we don't blow up memory with multi-page
  // comment dumps; reflection worker can promote facts from longer
  // sources via document_revisions if needed.
  const excerpt =
    event.commentExcerpt.length > 500
      ? event.commentExcerpt.slice(0, 500) + "…"
      : event.commentExcerpt;
  fireAndForget(
    svc.write(ctx, {
      scope: {
        companyId: event.companyId,
        agentId: event.agentId,
        sessionId: event.issueId ?? event.runId,
        sessionKind: event.issueId ? "issue" : "run",
      },
      kind: "episodic",
      content: `Comment from ${event.commentBy}: ${excerpt}`,
      sourceRunId: event.runId,
    }),
    "run.comment",
  );
}
