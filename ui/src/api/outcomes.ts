import { api } from "./client";

export interface OutcomeRowDto {
  id: string;
  kind: string;
  requiredMeta: Record<string, unknown>;
  status: "pending" | "verified" | "reverted";
  verifiedMeta?: Record<string, unknown>;
  verifiedAt?: string;
  revertedAt?: string;
}

export interface ListOutcomesResponse {
  outcomes: OutcomeRowDto[];
}

export function listOutcomes(target: {
  kind: "issue" | "plan";
  id: string;
  companyId: string;
}): Promise<OutcomeRowDto[]> {
  const params = new URLSearchParams({
    target_kind: target.kind,
    target_id: target.id,
  });
  return api
    .get<ListOutcomesResponse>(
      `/companies/${encodeURIComponent(target.companyId)}/outcomes?${params.toString()}`,
    )
    .then((r) => r.outcomes);
}

export function signOff(
  companyId: string,
  outcomeId: string,
  note?: string,
): Promise<unknown> {
  return api.post(
    `/companies/${encodeURIComponent(companyId)}/outcomes/${encodeURIComponent(outcomeId)}/signoff`,
    { note },
  );
}

export function revertOutcome(
  companyId: string,
  outcomeId: string,
  reason: string,
): Promise<unknown> {
  return api.post(
    `/companies/${encodeURIComponent(companyId)}/outcomes/${encodeURIComponent(outcomeId)}/revert`,
    { reason },
  );
}
