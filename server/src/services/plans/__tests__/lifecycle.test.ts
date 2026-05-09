import { describe, expect, it } from "vitest";
import { validatePhaseTransition, validatePlanTransition } from "../lifecycle.js";

describe("validatePlanTransition", () => {
  it("admits draft → under_review", () => {
    expect(validatePlanTransition("draft", "under_review").ok).toBe(true);
  });
  it("admits approved → in_progress → completed", () => {
    expect(validatePlanTransition("approved", "in_progress").ok).toBe(true);
    expect(validatePlanTransition("in_progress", "completed").ok).toBe(true);
  });
  it("admits in_progress → under_review (re-revision)", () => {
    expect(validatePlanTransition("in_progress", "under_review").ok).toBe(true);
  });
  it("rejects draft → completed", () => {
    expect(validatePlanTransition("draft", "completed").ok).toBe(false);
  });
  it("treats noop transitions as valid", () => {
    expect(validatePlanTransition("draft", "draft").ok).toBe(true);
  });
  it("completed and cancelled are terminal", () => {
    expect(validatePlanTransition("completed", "draft").ok).toBe(false);
    expect(validatePlanTransition("cancelled", "draft").ok).toBe(false);
  });
});

describe("validatePhaseTransition", () => {
  it("admits pending → ready → in_progress → completed", () => {
    expect(validatePhaseTransition("pending", "ready").ok).toBe(true);
    expect(validatePhaseTransition("ready", "in_progress").ok).toBe(true);
    expect(validatePhaseTransition("in_progress", "completed").ok).toBe(true);
  });
  it("admits blocked → pending (recovery)", () => {
    expect(validatePhaseTransition("blocked", "pending").ok).toBe(true);
  });
  it("rejects pending → completed (must transit through ready+in_progress)", () => {
    expect(validatePhaseTransition("pending", "completed").ok).toBe(false);
  });
  it("completed is terminal", () => {
    expect(validatePhaseTransition("completed", "pending").ok).toBe(false);
  });
});
