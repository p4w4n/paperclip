// Pure phase-readiness check.
//
// A phase is 'ready' when ALL its dep phases are completed.
// 'pending' if any dep is still running / queued / pre-start.
// 'blocked' if any dep is in a terminal-non-success state
// (skipped without running OR cancelled OR blocked itself) —
// the plan author has to fix the DAG to recover.

import type { PhaseStatus } from "./types.js";

export interface PhaseReadinessInput {
  // Statuses of every direct dependency. Empty array → no deps,
  // phase is ready immediately.
  depStatuses: ReadonlyArray<PhaseStatus>;
}

export type PhaseReadiness = "ready" | "pending" | "blocked";

export function phaseReadiness(input: PhaseReadinessInput): PhaseReadiness {
  if (input.depStatuses.length === 0) return "ready";
  let allCompleted = true;
  for (const s of input.depStatuses) {
    if (s === "completed") continue;
    if (s === "skipped" || s === "blocked") return "blocked";
    // pending / ready / in_progress mean we're just waiting.
    allCompleted = false;
  }
  return allCompleted ? "ready" : "pending";
}
