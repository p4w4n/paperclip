import { api } from "./client";

export interface OutcomeRowDto {
  id: string;
  kind: string;
  requiredMeta: Record<string, unknown>;
  status: "pending" | "verified" | "reverted";
  verifiedMeta?: Record<string, unknown>;
  verifiedAt?: string;
  revertedAt?: string;
  /** EO-P2-16: base name of the alias slot (e.g. "QA" for both "QA" and "QA:alt:0") */
  slot_base_name?: string;
  /** EO-P2-16: true if any row in this slot group is verified */
  slot_satisfied?: boolean;
  /** EO-P2-16: sibling alternatives for the primary row (empty for alt rows) */
  alternatives?: OutcomeRowDto[];
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
