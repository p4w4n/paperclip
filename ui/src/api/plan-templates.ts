// ui/src/api/plan-templates.ts
import { api } from "./client";

export interface PlanTemplateRow {
  id: string;
  companyId: string;
  name: string;
  descriptionMarkdown: string | null;
  initialContentMarkdown: string | null;
  defaultApprovalPolicy: string | null;
  defaultPhaseAdvancePolicy: string | null;
  suggestedOutcomesJson: unknown[] | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ListPlanTemplatesResponse {
  templates: PlanTemplateRow[];
}

export function listPlanTemplates(
  companyId: string,
  opts: { status?: string } = {},
): Promise<ListPlanTemplatesResponse> {
  const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
  return api.get<ListPlanTemplatesResponse>(
    `/companies/${encodeURIComponent(companyId)}/plan-templates${qs}`,
  );
}

export function getPlanTemplate(id: string): Promise<{ template: PlanTemplateRow }> {
  return api.get<{ template: PlanTemplateRow }>(
    `/plan-templates/${encodeURIComponent(id)}`,
  );
}

export function createPlanTemplate(
  companyId: string,
  body: {
    name: string;
    descriptionMarkdown?: string;
    initialContentMarkdown?: string;
    defaultApprovalPolicy?: string;
    defaultPhaseAdvancePolicy?: string;
    suggestedOutcomesJson?: unknown[];
  },
): Promise<{ template: PlanTemplateRow }> {
  return api.post<{ template: PlanTemplateRow }>(
    `/companies/${encodeURIComponent(companyId)}/plan-templates`,
    body,
  );
}

export function updatePlanTemplate(
  id: string,
  body: {
    name?: string;
    descriptionMarkdown?: string;
    initialContentMarkdown?: string;
    defaultApprovalPolicy?: string;
    defaultPhaseAdvancePolicy?: string;
    suggestedOutcomesJson?: unknown[];
  },
): Promise<{ template: PlanTemplateRow }> {
  return api.patch<{ template: PlanTemplateRow }>(
    `/plan-templates/${encodeURIComponent(id)}`,
    body,
  );
}

export function archivePlanTemplate(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/plan-templates/${encodeURIComponent(id)}/archive`,
    {},
  );
}

export function restorePlanTemplate(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/plan-templates/${encodeURIComponent(id)}/restore`,
    {},
  );
}

export function applyPlaybookToIssue(
  companyId: string,
  issueId: string,
  playbookId: string,
  mergeStrategy: "merge" | "replace",
): Promise<{ addedCount: number; skippedCount: number }> {
  return api.post<{ addedCount: number; skippedCount: number }>(
    `/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/apply-playbook`,
    { playbookId, mergeStrategy },
  );
}
