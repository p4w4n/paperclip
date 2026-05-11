import { z } from "zod";

// Inline the kinds to avoid a circular import with index.ts which re-exports
// this module. Must stay in sync with OUTCOME_KINDS in index.ts.
const OUTCOME_KINDS_TUPLE = [
  "artifact_declared",
  "plan_completed",
  "decision_recorded",
  "approval_granted",
  "exit_criteria_met",
  "manual_signoff",
  "external_signal",
] as const;

// Single-level OR alternative — same shape as the primary entry but without
// nested alternatives (no recursion). Use .strict() to reject any extra keys
// (including a nested `alternatives` field).
const contractAlternativeSchema = z.object({
  kind: z.enum(OUTCOME_KINDS_TUPLE),
  requiredMeta: z.record(z.unknown()),
}).strict();

export const contractEntrySchema = z.object({
  kind: z.enum(OUTCOME_KINDS_TUPLE),
  requiredMeta: z.record(z.unknown()),
  alternatives: z.array(contractAlternativeSchema).optional(),
});

export type ContractEntry = z.infer<typeof contractEntrySchema>;
export type ContractAlternative = z.infer<typeof contractAlternativeSchema>;
