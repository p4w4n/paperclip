// Pure state-transition validators for plans + phases.
//
// Allowed transitions are enumerated as edges of the lifecycle
// diagrams in the spec. Service.ts uses these as guards before
// any UPDATE; routes return 409 on illegal transitions.

import type { PhaseStatus, PlanStatus } from "./types.js";

const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, ReadonlyArray<PlanStatus>>> = {
  draft: ["under_review", "cancelled"],
  under_review: ["approved", "rejected", "draft", "cancelled"],
  approved: ["in_progress", "under_review", "cancelled"],
  in_progress: ["completed", "cancelled", "under_review"],
  completed: [],
  cancelled: [],
  rejected: ["draft"],
};

const PHASE_TRANSITIONS: Readonly<
  Record<PhaseStatus, ReadonlyArray<PhaseStatus>>
> = {
  pending: ["ready", "skipped", "blocked"],
  ready: ["in_progress", "skipped", "blocked"],
  in_progress: ["completed", "blocked"],
  completed: [],
  skipped: [],
  blocked: ["pending", "ready"],
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export function validatePlanTransition(
  from: PlanStatus,
  to: PlanStatus,
): TransitionResult {
  if (from === to) return { ok: true };
  const allowed = PLAN_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    reason: `illegal plan transition: ${from} → ${to}`,
  };
}

export function validatePhaseTransition(
  from: PhaseStatus,
  to: PhaseStatus,
): TransitionResult {
  if (from === to) return { ok: true };
  const allowed = PHASE_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    reason: `illegal phase transition: ${from} → ${to}`,
  };
}

export const _testing = { PLAN_TRANSITIONS, PHASE_TRANSITIONS };
