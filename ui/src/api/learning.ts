import { api } from "./client";

export interface PlaybookRow {
  id: string;
  companyId: string;
  agentId: string | null;
  title: string;
  slug: string;
  status: "proposed" | "active" | "archived" | "superseded";
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  applicabilityConditions: Record<string, unknown> | null;
  sourceRunIds: string[] | null;
  sourcePlanIds: string[] | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  archivedAt: string | null;
}

export interface PlaybookRevisionRow {
  id: string;
  playbookId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contentMarkdown: string;
  changeSummary: string | null;
  createdAt: string;
}

export interface OutcomePatternRow {
  id: string;
  companyId: string;
  patternName: string;
  patternDescription: string | null;
  exemplarRunIds: string[];
  clusterSize: number;
  derivedAt: string;
  confidence: number;
  promotedToPlaybookId: string | null;
}

export interface AgentSkillRow {
  agentId: string;
  companyId: string;
  skillName: string;
  evidenceRunIds: string[];
  lastEvidencedAt: string;
  confidence: number;
  derivedAt: string;
}

export interface DecisionPatternRow {
  id: string;
  companyId: string;
  conditionSummary: string;
  typicalChoice: string;
  exemplarDecisionIds: string[];
  clusterSize: number;
  derivedAt: string;
  confidence: number;
}

export function listPlaybooks(
  companyId: string,
  opts: { status?: string; agentId?: string | null } = {},
) {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.agentId === null) qs.set("agentId", "null");
  else if (opts.agentId) qs.set("agentId", opts.agentId);
  const q = qs.toString();
  return api.get<{ playbooks: PlaybookRow[] }>(
    `/companies/${encodeURIComponent(companyId)}/playbooks${q ? `?${q}` : ""}`,
  );
}

export function getPlaybook(id: string) {
  return api.get<{ playbook: PlaybookRow; currentRevision: PlaybookRevisionRow | null }>(
    `/playbooks/${encodeURIComponent(id)}`,
  );
}

export function approvePlaybook(id: string) {
  return api.post<{ ok: true }>(`/playbooks/${encodeURIComponent(id)}/approve`, {});
}

export function archivePlaybook(id: string) {
  return api.post<{ ok: true }>(`/playbooks/${encodeURIComponent(id)}/archive`, {});
}

export function listOutcomePatterns(companyId: string) {
  return api.get<{ patterns: OutcomePatternRow[] }>(
    `/companies/${encodeURIComponent(companyId)}/outcome-patterns`,
  );
}

export function promotePattern(
  patternId: string,
  body: { contentMarkdown: string; title?: string; slug?: string },
) {
  return api.post<{ playbook: PlaybookRow }>(
    `/outcome-patterns/${encodeURIComponent(patternId)}/promote`,
    body,
  );
}

export function listAgentSkills(agentId: string) {
  return api.get<{ skills: AgentSkillRow[] }>(
    `/agents/${encodeURIComponent(agentId)}/skills`,
  );
}

export function listDecisionPatterns(companyId: string) {
  return api.get<{ patterns: DecisionPatternRow[] }>(
    `/companies/${encodeURIComponent(companyId)}/decision-patterns`,
  );
}
