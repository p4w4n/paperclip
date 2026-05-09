// Pure: applies the per-routine retry_policy override on top of
// per-class defaults. Returns RetryDecision (retry / dead_letter
// / discard) which the scheduler uses to either UPDATE the
// work_item back to 'queued' with new available_at + attempts++
// or transition to 'dead_letter'.
//
// Defaults per spec:
//   transient_provider — exponential 2^attempts seconds, capped 5min
//   transient_local    — immediate retry; same dead-letter cap
//   poison             — dead_letter immediately
//   quota_exceeded     — defer to nextBudgetWindow (caller-supplied);
//                        does NOT count against attempts
//   permanent          — dead_letter

import type { RetryClass, RetryDecision, RetryPolicy } from "./types.js";

const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface ApplyRetryInput {
  retryClass: RetryClass;
  attempts: number;          // current attempts (pre-increment)
  maxAttempts: number;       // from work_items.max_attempts
  policy: RetryPolicy | null;
  // Caller supplies the next-budget-window time for quota_exceeded.
  // Optional — if missing, quota_exceeded falls back to a 1h delay.
  nextBudgetWindowAt?: Date;
  now?: Date;
}

export function applyRetryPolicy(input: ApplyRetryInput): RetryDecision {
  const now = input.now ?? new Date();
  const policy = input.policy ?? {};
  const cap = policy.backoff_cap_ms ?? DEFAULT_BACKOFF_CAP_MS;
  const maxAttempts = policy.max_attempts ?? input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const nextAttempts = input.attempts + 1;

  switch (input.retryClass) {
    case "poison":
      if (policy.on_poison === "discard") return { kind: "discard" };
      return { kind: "dead_letter", reason: "poison" };

    case "permanent":
      return { kind: "dead_letter", reason: "permanent" };

    case "quota_exceeded": {
      const at = input.nextBudgetWindowAt ?? new Date(now.getTime() + 60 * 60 * 1000);
      // quota does NOT count against attempts (it's not a real
      // failure of the work — the company just ran out of budget).
      return { kind: "retry", availableAt: at, attempts: input.attempts };
    }

    case "transient_local":
      if (nextAttempts >= maxAttempts) {
        return { kind: "dead_letter", reason: "transient_local_exhausted" };
      }
      return { kind: "retry", availableAt: now, attempts: nextAttempts };

    case "transient_provider": {
      if (nextAttempts >= maxAttempts) {
        return { kind: "dead_letter", reason: "transient_provider_exhausted" };
      }
      const backoff = Math.min(cap, Math.pow(2, input.attempts) * 1000);
      return {
        kind: "retry",
        availableAt: new Date(now.getTime() + backoff),
        attempts: nextAttempts,
      };
    }
  }
}
