import { verifyArtifactDeclared } from "./artifact-declared.js";
import { verifyPlanCompleted } from "./plan-completed.js";
import { verifyDecisionRecorded } from "./decision-recorded.js";

export { verifyArtifactDeclared, type ArtifactEvidence } from "./artifact-declared.js";
export { verifyPlanCompleted, type PlanCompletedEvidence } from "./plan-completed.js";
export { verifyDecisionRecorded, type DecisionEvidence } from "./decision-recorded.js";

export const VERIFIERS = {
  artifact_declared: verifyArtifactDeclared,
  plan_completed: verifyPlanCompleted,
  decision_recorded: verifyDecisionRecorded,
} as const;

export type VerifierKind = keyof typeof VERIFIERS;
