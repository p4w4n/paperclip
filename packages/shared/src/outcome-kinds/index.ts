// Outcome-kind registry. Each kind defines the zod schema that validates
// the required_meta JSON stored on an outcomes row.

import { artifactDeclaredSchema } from "./artifact-declared.js";
import { planCompletedSchema } from "./plan-completed.js";
import { decisionRecordedSchema } from "./decision-recorded.js";
import { approvalGrantedSchema } from "./approval-granted.js";
import { exitCriteriaMetSchema } from "./exit-criteria-met.js";
import { manualSignoffSchema } from "./manual-signoff.js";
import { externalSignalSchema } from "./external-signal.js";

export const OUTCOME_KINDS = [
  "artifact_declared",
  "plan_completed",
  "decision_recorded",
  "approval_granted",
  "exit_criteria_met",
  "manual_signoff",
  "external_signal",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const requiredSchemas = {
  artifact_declared: artifactDeclaredSchema,
  plan_completed: planCompletedSchema,
  decision_recorded: decisionRecordedSchema,
  approval_granted: approvalGrantedSchema,
  exit_criteria_met: exitCriteriaMetSchema,
  manual_signoff: manualSignoffSchema,
  external_signal: externalSignalSchema,
};

export type RequiredMetaValidation = { ok: true } | { ok: false; errors: string[] };

export function validateRequiredMeta(kind: OutcomeKind, meta: unknown): RequiredMetaValidation {
  const result = requiredSchemas[kind].safeParse(meta);
  if (result.success) return { ok: true };
  return { ok: false, errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`) };
}
