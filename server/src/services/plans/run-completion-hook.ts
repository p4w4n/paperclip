// Heartbeat hook: when a heartbeat_run completes, if the run is
// linked to a plan_phase via plan_phase_runs, advance the phase
// per the plan's exit-criteria check.
//
// Auto-completion rule (v1):
//   - run terminal status = 'succeeded' AND
//   - phase has no exit_criteria_markdown OR all checkbox lines
//     in exit_criteria_markdown are checked in the run summary
//   → phase transitions to completed (which may transition the
//     plan to completed via the existing completePhase path).
//
// run terminal status = 'failed' / 'timed_out' → phase stays
// in_progress (work-queue retry will re-fire); after attempts
// exhausted the work_item moves to dead_letter and the operator
// decides via the admin UI.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { planPhaseRuns, planPhases } from "@paperclipai/db";
import type { PlanService, PlanServiceContext } from "./types.js";

export interface RunCompletionHookInput {
  runId: string;
  terminalState: "succeeded" | "failed" | "timed_out";
  // Run summary text — the agent's terminal output. Used to test
  // exit-criteria checkbox completion.
  summary?: string | null;
}

/**
 * Returns true iff the phase auto-advanced. False on no-op
 * (run not linked to a plan phase, exit criteria unmet, etc.).
 */
export async function onRunCompletedForPhase(
  db: Db,
  planService: PlanService,
  ctx: PlanServiceContext,
  input: RunCompletionHookInput,
): Promise<boolean> {
  if (input.terminalState !== "succeeded") return false;

  const [link] = await db
    .select({ phaseId: planPhaseRuns.phaseId })
    .from(planPhaseRuns)
    .where(eq(planPhaseRuns.runId, input.runId))
    .limit(1);
  if (!link) return false;

  const [phase] = await db
    .select()
    .from(planPhases)
    .where(eq(planPhases.id, link.phaseId));
  if (!phase) return false;

  const exitCriteriaMet = checkExitCriteria(
    phase.exitCriteriaMarkdown ?? null,
    input.summary ?? null,
  );
  if (!exitCriteriaMet) return false;

  await planService.completePhase(ctx, link.phaseId, true);
  return true;
}

/**
 * Pure helper: given exit-criteria markdown (a checklist) and a
 * run summary, decide whether all required boxes are checked.
 *
 * Rules:
 *   - empty / null exit_criteria → met (no requirements).
 *   - lines like `- [ ] do thing` are unchecked items.
 *   - lines like `- [x] do thing` (or [X]) are checked items.
 *   - We extract unchecked items from exit_criteria; for each one,
 *     test whether the summary contains its text (case-insensitive
 *     substring) prefixed with a check or simply mentions it as
 *     done. v1 heuristic — a more semantic LLM check is Plan 2.
 *   - If summary is missing, exit-criteria with any unchecked items
 *     are NOT met.
 */
export function checkExitCriteria(
  exitCriteriaMarkdown: string | null,
  summary: string | null,
): boolean {
  if (!exitCriteriaMarkdown || exitCriteriaMarkdown.trim().length === 0) {
    return true;
  }
  const items = extractUncheckedItems(exitCriteriaMarkdown);
  if (items.length === 0) return true;
  if (!summary) return false;
  const haystack = summary.toLowerCase();
  return items.every((item) => haystack.includes(item.toLowerCase()));
}

function extractUncheckedItems(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\s*- \[ \]\s+(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}
