import { verifyArtifactDeclared } from "./artifact-declared.js";
import { verifyPlanCompleted } from "./plan-completed.js";
import { verifyDecisionRecorded } from "./decision-recorded.js";
import { verifyApprovalGranted } from "./approval-granted.js";
import { verifyExitCriteriaMet } from "./exit-criteria-met.js";

export { verifyArtifactDeclared, type ArtifactEvidence } from "./artifact-declared.js";
export { verifyPlanCompleted, type PlanCompletedEvidence } from "./plan-completed.js";
export { verifyDecisionRecorded, type DecisionEvidence } from "./decision-recorded.js";
export { verifyApprovalGranted, type ApprovalEvidence } from "./approval-granted.js";
export { verifyExitCriteriaMet, type PhaseEvidence } from "./exit-criteria-met.js";

// Route-driven verifiers — NOT in VERIFIERS auto-dispatch map.
export {
  verifyManualSignoff,
  SignoffRoleMismatchError,
  type ManualSignoffInput,
} from "./manual-signoff.js";

export {
  ingestExternalSignal,
  SignalAuthError,
  SignalReplayMismatchError,
  type SignalIngestInput,
} from "./external-signal.js";

export const VERIFIERS = {
  artifact_declared: verifyArtifactDeclared,
  plan_completed: verifyPlanCompleted,
  decision_recorded: verifyDecisionRecorded,
  approval_granted: verifyApprovalGranted,
  exit_criteria_met: verifyExitCriteriaMet,
} as const;

export type VerifierKind = keyof typeof VERIFIERS;
