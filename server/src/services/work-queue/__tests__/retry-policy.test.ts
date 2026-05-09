import { describe, expect, it } from "vitest";
import { applyRetryPolicy } from "../retry-policy.js";

const NOW = new Date("2026-05-15T10:00:00Z");

describe("applyRetryPolicy", () => {
  it("poison goes straight to dead_letter", () => {
    const out = applyRetryPolicy({
      retryClass: "poison",
      attempts: 0,
      maxAttempts: 3,
      policy: null,
      now: NOW,
    });
    expect(out.kind).toBe("dead_letter");
  });

  it("policy.on_poison='discard' yields discard", () => {
    const out = applyRetryPolicy({
      retryClass: "poison",
      attempts: 0,
      maxAttempts: 3,
      policy: { on_poison: "discard" },
      now: NOW,
    });
    expect(out.kind).toBe("discard");
  });

  it("permanent goes to dead_letter", () => {
    const out = applyRetryPolicy({
      retryClass: "permanent",
      attempts: 0,
      maxAttempts: 3,
      policy: null,
      now: NOW,
    });
    expect(out.kind).toBe("dead_letter");
  });

  it("quota_exceeded retries at nextBudgetWindowAt without counting attempt", () => {
    const next = new Date(NOW.getTime() + 3600_000);
    const out = applyRetryPolicy({
      retryClass: "quota_exceeded",
      attempts: 1,
      maxAttempts: 3,
      policy: null,
      nextBudgetWindowAt: next,
      now: NOW,
    });
    expect(out).toEqual({ kind: "retry", availableAt: next, attempts: 1 });
  });

  it("transient_local retries immediately + bumps attempts", () => {
    const out = applyRetryPolicy({
      retryClass: "transient_local",
      attempts: 0,
      maxAttempts: 3,
      policy: null,
      now: NOW,
    });
    if (out.kind !== "retry") throw new Error("expected retry");
    expect(out.attempts).toBe(1);
    expect(out.availableAt).toEqual(NOW);
  });

  it("transient_provider exponential backoff (2s on 2nd attempt)", () => {
    const out = applyRetryPolicy({
      retryClass: "transient_provider",
      attempts: 1, // next attempt = 2
      maxAttempts: 5,
      policy: null,
      now: NOW,
    });
    if (out.kind !== "retry") throw new Error("expected retry");
    expect(out.availableAt.getTime() - NOW.getTime()).toBe(2000);
  });

  it("transient_provider caps at backoff_cap_ms", () => {
    const out = applyRetryPolicy({
      retryClass: "transient_provider",
      attempts: 30, // 2^30 seconds way over cap
      maxAttempts: 100,
      policy: { backoff_cap_ms: 60_000 },
      now: NOW,
    });
    if (out.kind !== "retry") throw new Error("expected retry");
    expect(out.availableAt.getTime() - NOW.getTime()).toBe(60_000);
  });

  it("dead_letter on max_attempts exhausted", () => {
    const out = applyRetryPolicy({
      retryClass: "transient_provider",
      attempts: 3,
      maxAttempts: 3,
      policy: null,
      now: NOW,
    });
    expect(out.kind).toBe("dead_letter");
  });
});
