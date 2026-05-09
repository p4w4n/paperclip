// Pure applicability matcher. Runs on the hot path (suggestPlaybooks
// is called per-run-start), so it's cheap: keyword + label hits +
// project / agent scope multipliers, weighted by playbook confidence,
// clamped to [0, 1].

import type { ApplicabilityConditions, IssueContext, Playbook } from "./types.js";

export interface MatchResult {
  score: number;
  reason: string;
}

export function matchPlaybookApplicability(
  ctx: IssueContext,
  playbook: Playbook,
): MatchResult {
  const conditions: ApplicabilityConditions = playbook.applicabilityConditions ?? {};
  let score = 0;
  const reasons: string[] = [];

  // Keyword match — case-insensitive substring on title.
  if (conditions.issue_keywords?.length) {
    const lowerTitle = ctx.title.toLowerCase();
    const hits = conditions.issue_keywords.filter((k) =>
      lowerTitle.includes(k.toLowerCase()),
    );
    if (hits.length > 0) {
      score += hits.length * 0.2;
      reasons.push(`keywords: ${hits.join(", ")}`);
    }
  }

  // Label match — exact membership.
  if (conditions.labels?.length) {
    const hits = conditions.labels.filter((l) => ctx.labels.includes(l));
    if (hits.length > 0) {
      score += hits.length * 0.3;
      reasons.push(`labels: ${hits.join(", ")}`);
    }
  }

  // Project scope.
  if (conditions.project_id && ctx.projectId === conditions.project_id) {
    score += 0.5;
    reasons.push("project match");
  }

  // Agent scope. agent-attached playbooks score higher when the
  // assignee matches.
  if (playbook.agentId && playbook.agentId === ctx.assigneeAgentId) {
    score += 0.4;
    reasons.push("agent match");
  }

  // Confidence weight.
  score *= playbook.confidence;

  return {
    score: Math.min(1, score),
    reason: reasons.join("; "),
  };
}
