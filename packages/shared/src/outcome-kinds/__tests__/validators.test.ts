import { describe, expect, it } from "vitest";
import {
  OUTCOME_KINDS,
  validateRequiredMeta,
  type OutcomeKind,
} from "../index.js";

describe("outcome-kinds validators", () => {
  it("exports the seven Plan-1 kinds", () => {
    expect(OUTCOME_KINDS).toEqual([
      "artifact_declared",
      "plan_completed",
      "decision_recorded",
      "approval_granted",
      "exit_criteria_met",
      "manual_signoff",
      "external_signal",
    ]);
  });

  it("requires a string `name` on every kind", () => {
    for (const kind of OUTCOME_KINDS) {
      const result = validateRequiredMeta(kind, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatch(/name/);
    }
  });

  it("artifact_declared requires artifact_kind + name", () => {
    expect(validateRequiredMeta("artifact_declared", { name: "patch" }).ok).toBe(false);
    expect(
      validateRequiredMeta("artifact_declared", { name: "patch", artifact_kind: "code.patch" }).ok,
    ).toBe(true);
  });

  it("decision_recorded requires plan_id + decision_title", () => {
    expect(validateRequiredMeta("decision_recorded", { name: "go" }).ok).toBe(false);
    expect(
      validateRequiredMeta("decision_recorded", {
        name: "go", plan_id: "00000000-0000-0000-0000-000000000000", decision_title: "release-go",
      }).ok,
    ).toBe(true);
  });

  it("manual_signoff allows optional required_role", () => {
    expect(validateRequiredMeta("manual_signoff", { name: "ack" }).ok).toBe(true);
    expect(validateRequiredMeta("manual_signoff", { name: "ack", required_role: "ops" }).ok).toBe(true);
  });
});
