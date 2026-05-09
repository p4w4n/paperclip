// Plugin contract for the deep-planning service.
//
// Tenant isolation runs at the service layer — every input
// carries companyId; assertTenant rejects cross-company calls.

export type PlanStatus =
  | "draft"
  | "under_review"
  | "approved"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "rejected";

export type PhaseStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "completed"
  | "skipped"
  | "blocked";

export type ReviewDecision = "approved" | "requested_changes" | "rejected";

export type ApprovalPolicy = "one_human" | "all_assignees" | "agent_only" | "none";

export type PhaseAdvancePolicy = "auto" | "manual";

export interface PlanServiceContext {
  callerCompanyId: string;
}

export interface PhaseDraft {
  name: string;
  descriptionMarkdown?: string;
  exitCriteriaMarkdown?: string;
  ordering?: number;
  assigneeAgentId?: string;
  // Optional: ordering positions of phases this one depends on.
  // Resolved at create time into plan_phase_dependencies edges.
  dependsOnOrdering?: number[];
}

export interface CreatePlanInput {
  companyId: string;
  issueId?: string;
  title: string;
  initialContent: string;
  approvalPolicy?: ApprovalPolicy;
  phaseAdvancePolicy?: PhaseAdvancePolicy;
  phases?: PhaseDraft[];
  createdByAgentId?: string;
}

export interface PlanRevisionInput {
  contentMarkdown: string;
  changeSummary: string;
  createdByAgentId?: string;
}

export interface SubmitReviewInput {
  decision: ReviewDecision;
  revisionId?: string;
  comment?: string;
  reviewerAgentId?: string;
}

export interface DecisionInput {
  title: string;
  options: Array<{ id: string; label: string }>;
  chosenOptionId: string;
  rationaleMarkdown?: string;
  phaseId?: string;
  decidedByAgentId?: string;
}

export interface PlanRow {
  id: string;
  companyId: string;
  issueId: string | null;
  title: string;
  status: PlanStatus;
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  approvalPolicy: ApprovalPolicy;
  phaseAdvancePolicy: PhaseAdvancePolicy;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  completedAt: Date | null;
}

export interface PlanRevisionRow {
  id: string;
  planId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contentMarkdown: string;
  changeSummary: string | null;
  status: "proposed" | "approved" | "rejected" | "superseded";
  createdAt: Date;
}

export interface PlanPhaseRow {
  id: string;
  planId: string;
  ordering: number;
  name: string;
  descriptionMarkdown: string | null;
  exitCriteriaMarkdown: string | null;
  status: PhaseStatus;
  assigneeAgentId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface PlanReviewRow {
  id: string;
  planId: string;
  revisionId: string | null;
  reviewerUserId: string | null;
  reviewerAgentId: string | null;
  decision: ReviewDecision;
  commentMarkdown: string | null;
  createdAt: Date;
}

export interface PlanDecisionRow {
  id: string;
  planId: string;
  phaseId: string | null;
  title: string;
  options: Array<{ id: string; label: string }>;
  chosenOptionId: string;
  rationaleMarkdown: string | null;
  decidedAt: Date;
  supersededById: string | null;
}

export interface PlanService {
  createPlan(ctx: PlanServiceContext, input: CreatePlanInput): Promise<PlanRow>;
  revisePlan(
    ctx: PlanServiceContext,
    planId: string,
    input: PlanRevisionInput,
  ): Promise<PlanRevisionRow>;
  submitReview(
    ctx: PlanServiceContext,
    planId: string,
    input: SubmitReviewInput,
  ): Promise<void>;
  startPhase(ctx: PlanServiceContext, phaseId: string): Promise<void>;
  completePhase(
    ctx: PlanServiceContext,
    phaseId: string,
    exitCriteriaMet: boolean,
  ): Promise<void>;
  recordDecision(
    ctx: PlanServiceContext,
    planId: string,
    input: DecisionInput,
  ): Promise<PlanDecisionRow>;
  forget(ctx: PlanServiceContext, planId: string): Promise<void>;
}

export class PlanTenantMismatchError extends Error {
  constructor(callerCompanyId: string, inputCompanyId: string) {
    super(
      `plan tenant mismatch: caller company ${callerCompanyId} does not match input ${inputCompanyId}`,
    );
    this.name = "PlanTenantMismatchError";
  }
}
