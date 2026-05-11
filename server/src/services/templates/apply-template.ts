// Pure projection helper. Takes a PlanTemplateRow and returns a deep-cloned
// contract array suitable for OutcomesService.materializeContract.

import type { ContractEntry } from "../outcomes/contract.js";

export interface PlanTemplateInput {
  defaultRequiredOutcomes: unknown[];
}

export function projectTemplateToContract(template: PlanTemplateInput): ContractEntry[] {
  // Deep clone via JSON round-trip — defaults are plain JSONB so this is sound.
  return JSON.parse(JSON.stringify(template.defaultRequiredOutcomes ?? [])) as ContractEntry[];
}
