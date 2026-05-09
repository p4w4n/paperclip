import { api } from "./client";

export interface WorkItemSummary {
  id: string;
  companyId: string;
  queue: string;
  priority: number;
  state: string;
  attempts: number;
  maxAttempts: number;
  enqueuedByKind: string;
  enqueuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
}

export interface DepthSnapshot {
  companyId: string;
  queue: string;
  depth: number;
}

export interface AdminWorkQueueResponse {
  depth: DepthSnapshot[];
  deadLetter: WorkItemSummary[];
}

export function listAdminWorkQueue(): Promise<AdminWorkQueueResponse> {
  return api.get<AdminWorkQueueResponse>("/admin/work-queue");
}

export function replayDeadLetter(itemId: string, resetAttempts = true) {
  return api.post<{ ok: true }>(`/admin/work-queue/replay/${encodeURIComponent(itemId)}`, {
    resetAttempts,
  });
}

export function cancelWorkItem(itemId: string) {
  return api.post<{ ok: true }>(`/admin/work-queue/cancel/${encodeURIComponent(itemId)}`, {});
}
