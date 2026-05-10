// Types for OutcomesService.
// OutcomeRequiredError is the structured 422 thrown by the gate-check predicate
// (Task 12) when an issue or plan tries to flow to a terminal state with pending outcomes.

export type OutcomeTargetKind = "issue" | "plan";

export interface OutcomeTarget {
  kind: OutcomeTargetKind;
  id: string;
  companyId: string;
}

export interface OutcomeRowLite {
  id: string;
  kind: string;
  requiredMeta: { name: string; [k: string]: unknown };
  status: "pending" | "verified" | "reverted";
  verifiedMeta?: unknown;
  verifiedAt?: Date | null;
  revertedAt?: Date | null;
  revertedReason?: string | null;
}

export class OutcomeRequiredError extends Error {
  statusCode = 422;
  constructor(public payload: { target: { kind: OutcomeTargetKind; id: string }; pending: OutcomeRowLite[] }) {
    super(`Outcome required: ${payload.pending.length} pending`);
  }
  get body() {
    return {
      code: "outcome_required",
      target: this.payload.target,
      pending: this.payload.pending.map((p) => ({
        id: p.id, kind: p.kind, required_meta: p.requiredMeta,
      })),
    };
  }
}
