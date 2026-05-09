// Suggest hot path. The heartbeat hook calls this with the issue
// context just before the run begins; the result feeds into the
// memory prompt-prefix (L-14).
//
// Thin wrapper around OrgLearningService.suggestPlaybooks that
// adds a default threshold + limit + reads env overrides
// (LEARNING_SUGGEST_THRESHOLD, LEARNING_SUGGEST_LIMIT).

import type {
  IssueContext,
  OrgLearningService,
  OrgLearningServiceContext,
  SuggestionResult,
} from "./types.js";

export interface SuggestPlaybooksInput {
  companyId: string;
  issueContext: IssueContext;
  limit?: number;
  threshold?: number;
}

export async function suggestPlaybooks(
  svc: OrgLearningService,
  ctx: OrgLearningServiceContext,
  input: SuggestPlaybooksInput,
): Promise<SuggestionResult[]> {
  const threshold =
    input.threshold ??
    (process.env.LEARNING_SUGGEST_THRESHOLD
      ? parseFloat(process.env.LEARNING_SUGGEST_THRESHOLD)
      : 0.3);
  const limit =
    input.limit ??
    (process.env.LEARNING_SUGGEST_LIMIT
      ? parseInt(process.env.LEARNING_SUGGEST_LIMIT, 10)
      : 3);
  return svc.suggestPlaybooks(ctx, {
    companyId: input.companyId,
    issueContext: input.issueContext,
    threshold,
    limit,
  });
}
