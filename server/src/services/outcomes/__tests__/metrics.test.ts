// Smoke tests for outcomes metrics module.
// Verifies that the module exposes the expected counter/gauge instruments
// and that helper functions are callable without throwing (even when the
// OTel SDK meter is the no-op default).

import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMetrics,
  recordGateBlocked,
  recordSignalReceived,
  recordVerified,
  recordReverted,
  recordVerifierError,
  updatePendingGauge,
} from "../metrics.js";
import {
  templateAppliedCounter,
  webhookReceivedCounter,
  webhookSignatureFailedCounter,
  playbookAppliedCounter,
  autoReopenCounter,
  autoReopenFailedCounter,
  autoReopenSuppressedCounter,
  aliasSlotSatisfiedCounter,
} from "../metrics.js";

afterEach(() => _resetMetrics());

describe("outcomes metrics", () => {
  it("exposes the five expected counter/gauge instruments without throwing", () => {
    expect(() => recordVerified("artifact_declared")).not.toThrow();
    expect(() => recordReverted("plan_completed", "operator")).not.toThrow();
    expect(() => recordGateBlocked("issue")).not.toThrow();
    expect(() => recordSignalReceived(true)).not.toThrow();
    expect(() => recordVerifierError("exit_criteria_met")).not.toThrow();
  });

  it("pending gauge updates are stored cleanly", () => {
    const map = new Map<string, number>([
      ["artifact_declared|issue", 2],
      ["plan_completed|plan", 1],
    ]);
    expect(() => updatePendingGauge(map)).not.toThrow();
  });
});

describe("outcomes metrics — Plan 2", () => {
  it("exposes the new counters", () => {
    expect(templateAppliedCounter).toBeDefined();
    expect(webhookReceivedCounter).toBeDefined();
    expect(webhookSignatureFailedCounter).toBeDefined();
    expect(playbookAppliedCounter).toBeDefined();
    expect(autoReopenCounter).toBeDefined();
    expect(autoReopenFailedCounter).toBeDefined();
    expect(autoReopenSuppressedCounter).toBeDefined();
    expect(aliasSlotSatisfiedCounter).toBeDefined();
  });
});
