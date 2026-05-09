import { api } from "./client";

export interface PlanRow {
  id: string;
  companyId: string;
  issueId: string | null;
  title: string;
  status: string;
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  approvalPolicy: string;
  phaseAdvancePolicy: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
}

export interface PlanRevisionRow {
  id: string;
  planId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contentMarkdown: string;
  changeSummary: string | null;
  status: string;
  createdAt: string;
}

export interface PlanPhaseRow {
  id: string;
  planId: string;
  ordering: number;
  name: string;
  descriptionMarkdown: string | null;
  exitCriteriaMarkdown: string | null;
  status: string;
  assigneeAgentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PlanDecisionRow {
  id: string;
  planId: string;
  phaseId: string | null;
  title: string;
  optionsJson: Array<{ id: string; label: string }>;
  chosenOptionId: string;
  rationaleMarkdown: string | null;
  decidedAt: string;
}

export interface PlanReviewRow {
  id: string;
  planId: string;
  revisionId: string | null;
  reviewerUserId: string | null;
  reviewerAgentId: string | null;
  decision: "approved" | "requested_changes" | "rejected";
  commentMarkdown: string | null;
  createdAt: string;
}

export interface GetPlanResponse {
  plan: PlanRow;
  currentRevision: PlanRevisionRow | null;
  phases: PlanPhaseRow[];
}

export function getPlan(id: string): Promise<GetPlanResponse> {
  return api.get<GetPlanResponse>(`/plans/${encodeURIComponent(id)}`);
}

export function listPlanRevisions(id: string) {
  return api.get<{ revisions: PlanRevisionRow[] }>(
    `/plans/${encodeURIComponent(id)}/revisions`,
  );
}

export function listPlanDecisions(id: string) {
  return api.get<{ decisions: PlanDecisionRow[] }>(
    `/plans/${encodeURIComponent(id)}/decisions`,
  );
}

export function listPlanReviews(id: string) {
  return api.get<{ reviews: PlanReviewRow[] }>(
    `/plans/${encodeURIComponent(id)}/reviews`,
  );
}

export function listPlansForIssue(issueId: string) {
  return api.get<{ plan: PlanRow | null }>(
    // No endpoint specifically for "by-issue"; we use the company
    // plans index filtered by issueId in v1.
    `/companies/_/plans?issueId=${encodeURIComponent(issueId)}`,
  );
}

export function createPlanForIssue(issueId: string, body: {
  title: string;
  initialContent: string;
  approvalPolicy?: string;
  phaseAdvancePolicy?: string;
}) {
  return api.post<{ plan: PlanRow }>(
    `/issues/${encodeURIComponent(issueId)}/plans`,
    body,
  );
}

export function revisePlan(id: string, body: { contentMarkdown: string; changeSummary: string }) {
  return api.post<{ revision: PlanRevisionRow }>(
    `/plans/${encodeURIComponent(id)}/revisions`,
    body,
  );
}

export function submitReview(id: string, body: {
  decision: "approved" | "requested_changes" | "rejected";
  comment?: string;
  revisionId?: string;
}) {
  return api.post<{ ok: true }>(
    `/plans/${encodeURIComponent(id)}/reviews`,
    body,
  );
}

export function startPhase(planId: string, phaseId: string) {
  return api.post<{ ok: true }>(
    `/plans/${encodeURIComponent(planId)}/phases/${encodeURIComponent(phaseId)}/start`,
    {},
  );
}

export function completePhase(planId: string, phaseId: string) {
  return api.post<{ ok: true }>(
    `/plans/${encodeURIComponent(planId)}/phases/${encodeURIComponent(phaseId)}/complete`,
    { exitCriteriaMet: true },
  );
}

export function listAllPlans(companyId: string, status?: string) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return api.get<{ plans: PlanRow[] }>(
    `/companies/${encodeURIComponent(companyId)}/plans${qs}`,
  );
}
