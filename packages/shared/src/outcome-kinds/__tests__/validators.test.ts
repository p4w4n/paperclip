import { describe, expect, it } from "vitest";
import {
  OUTCOME_KINDS,
  validateRequiredMeta,
  type OutcomeKind,
} from "../index.js";
import { contractEntrySchema } from "../contract-entry.js";

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

describe("contractEntrySchema (Plan 2)", () => {
  it("accepts entry without alternatives", () => {
    const r = contractEntrySchema.safeParse({
      kind: "manual_signoff",
      requiredMeta: { name: "ack" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts entry with one alternative of a different kind", () => {
    const r = contractEntrySchema.safeParse({
      kind: "external_signal",
      requiredMeta: { name: "ci-pass", source: "github-actions" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: { required_role: "ops" } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects nested alternatives in an alternative (single-level OR only)", () => {
    const r = contractEntrySchema.safeParse({
      kind: "external_signal",
      requiredMeta: { name: "ci-pass" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: {}, alternatives: [{ kind: "manual_signoff", requiredMeta: {} }] },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("per-kind auto_reopen_on_revert flag (Plan 2)", () => {
  it("external_signal accepts auto_reopen_on_revert=true", () => {
    expect(validateRequiredMeta("external_signal", {
      name: "ci", source: "x", auto_reopen_on_revert: true,
    }).ok).toBe(true);
  });

  it("manual_signoff accepts auto_reopen_on_revert=false", () => {
    expect(validateRequiredMeta("manual_signoff", {
      name: "ack", auto_reopen_on_revert: false,
    }).ok).toBe(true);
  });

  it("auto_reopen_on_revert must be a boolean", () => {
    const r = validateRequiredMeta("external_signal", {
      name: "ci", source: "x", auto_reopen_on_revert: "yes",
    });
    expect(r.ok).toBe(false);
  });
});
