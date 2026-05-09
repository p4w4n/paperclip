// Salience decay — pure-function model + worker tick.
//
// A fact's salience starts at 0.5 (or 0.6 for promoted semantics)
// and drifts according to:
//   - Time decay: an exponential half-life of 14 days. Older,
//     un-touched facts gradually approach floor.
//   - Use boost: each recall hit (use_count++) lifts salience back
//     up; the boost is logarithmic so high use-count plateaus.
//   - Recency: a last-used delta lift on top of the base.
//
// Output is clamped to [floor, 1.0]; floor is 0.05 to keep sub-
// threshold facts queryable while pushing them out of recall
// ranking.
//
// Pure function so it's trivially testable and matches the lease-
// reaper "pure tick + production wire" pattern from Plan 2.

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const FLOOR = 0.05;
const USE_BOOST_CAP = 0.3;

export interface SalienceInputs {
  createdAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
  // The fact's most recent salience value; preserves prior decay
  // ticks rather than recomputing from createdAt every time.
  currentSalience: number;
  // Override "now" for testability.
  now?: Date;
}

export function computeSalience(inputs: SalienceInputs): number {
  const now = (inputs.now ?? new Date()).getTime();

  // Time decay anchored to last_used_at when present, else
  // created_at — that way recall keeps the fact "warm".
  const anchor = (inputs.lastUsedAt ?? inputs.createdAt).getTime();
  const ageMs = Math.max(0, now - anchor);
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);

  // Use-count boost (logarithmic, capped). 1 recall ≈ +0.0 at base,
  // 10 ≈ +0.1, 100 ≈ +0.2, plateau at +0.3.
  const useBoost = Math.min(USE_BOOST_CAP, Math.log10(inputs.useCount + 1) * 0.1);

  // Combine: anchor at currentSalience, decay it, add boost.
  const decayed = inputs.currentSalience * decay;
  const lifted = decayed + useBoost;

  if (lifted < FLOOR) return FLOOR;
  if (lifted > 1) return 1;
  return lifted;
}

export const SALIENCE_FLOOR = FLOOR;
