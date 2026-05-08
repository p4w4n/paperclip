import type {
  HeartbeatRun,
  HeartbeatRunEvent,
  InstanceSchedulerHeartbeatAgent,
  WorkspaceOperation,
} from "@paperclipai/shared";
import { api } from "./client";

export interface RunLivenessFields {
  livenessState: HeartbeatRun["livenessState"];
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: string | Date | null;
  nextAction: string | null;
}

export interface ActiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  contextCommentId?: string | null;
  contextWakeCommentId?: string | null;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  createdAt: string | Date;
  agentId: string;
  agentName: string;
  adapterType: string;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
  issueId?: string | null;
  livenessState?: RunLivenessFields["livenessState"];
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | Date | null;
  nextAction?: string | null;
  outputSilence?: HeartbeatRun["outputSilence"];
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  contextCommentId?: string | null;
  contextWakeCommentId?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
  issueId?: string | null;
  livenessState?: RunLivenessFields["livenessState"];
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | null;
  nextAction?: string | null;
  outputSilence?: HeartbeatRun["outputSilence"];
}

export interface WatchdogDecisionInput {
  runId: string;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  evaluationIssueId?: string | null;
  reason?: string | null;
  snoozedUntil?: string | null;
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`);
  },
  // Returns just the latest *failed* run per agent for the company, with
  // only the columns the inbox badge needs. Server-side equivalent of
  // running `getLatestFailedRunsByAgent` over the unbounded run history —
  // typically returns < 5 KB instead of the previous ~250 KB list pull.
  latestFailedPerAgent: (companyId: string) =>
    api.get<Array<Pick<HeartbeatRun, "id" | "companyId" | "agentId" | "status" | "createdAt"> & {
      error: string | null;
      errorCode: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }>>(`/companies/${companyId}/heartbeat-runs/latest-failed`),
  // Per-day per-status counts for charts. Server-side aggregate; the
  // response shape `{ date, status, count }[]` is what the SQL groupBy
  // returns directly. Use `aggregateStatsToActivityDays` (below) to
  // collapse that into the `DashboardRunActivityDay[]` shape that the
  // existing chart components consume. Optional agentId scopes to a
  // single agent (use this in AgentOverview); omit for company-wide. days
  // clamps to 1..90 server-side (default 14).
  stats: (companyId: string, options?: { agentId?: string; days?: number }) => {
    const params = new URLSearchParams();
    if (options?.agentId) params.set("agentId", options.agentId);
    if (options?.days) params.set("days", String(options.days));
    const qs = params.toString();
    return api.get<Array<{ date: string; status: string; count: number }>>(
      `/companies/${companyId}/heartbeat-runs/stats${qs ? `?${qs}` : ""}`,
    );
  },
  get: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/heartbeat-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  recordWatchdogDecision: (input: WatchdogDecisionInput) =>
    api.post(`/heartbeat-runs/${input.runId}/watchdog-decisions`, {
      decision: input.decision,
      evaluationIssueId: input.evaluationIssueId ?? null,
      reason: input.reason ?? null,
      snoozedUntil: input.snoozedUntil ?? null,
    }),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (
    companyId: string,
    options?: number | { minCount?: number; limit?: number },
  ) => {
    const searchParams = new URLSearchParams();
    if (typeof options === "number") {
      searchParams.set("minCount", String(options));
    } else if (options) {
      if (options.minCount) searchParams.set("minCount", String(options.minCount));
      if (options.limit) searchParams.set("limit", String(options.limit));
    }
    const qs = searchParams.toString();
    return api.get<LiveRunForIssue[]>(`/companies/${companyId}/live-runs${qs ? `?${qs}` : ""}`);
  },
  listInstanceSchedulerAgents: () =>
    api.get<InstanceSchedulerHeartbeatAgent[]>("/instance/scheduler-heartbeats"),
};

// Collapse the raw `{ date, status, count }[]` returned by
// /heartbeat-runs/stats into the `DashboardRunActivityDay[]` shape consumed
// by RunActivityChart / SuccessRateChart. Mirrors the `aggregateRuns`
// reducer in ActivityCharts.tsx but operates on pre-grouped server rows.
export function aggregateStatsToActivityDays(
  rows: Array<{ date: string; status: string; count: number }>,
  options?: { days?: number },
): Array<{ date: string; succeeded: number; failed: number; other: number; total: number }> {
  const days = options?.days ?? 14;
  const today = new Date();
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const grouped = new Map<string, { date: string; succeeded: number; failed: number; other: number; total: number }>();
  for (const day of dayKeys) {
    grouped.set(day, { date: day, succeeded: 0, failed: 0, other: 0, total: 0 });
  }
  for (const row of rows) {
    const entry = grouped.get(row.date);
    if (!entry) continue;
    if (row.status === "succeeded") entry.succeeded += row.count;
    else if (row.status === "failed" || row.status === "timed_out") entry.failed += row.count;
    else entry.other += row.count;
    entry.total += row.count;
  }
  return Array.from(grouped.values());
}
