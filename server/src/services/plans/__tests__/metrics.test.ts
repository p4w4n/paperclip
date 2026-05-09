import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMetrics,
  recordDecisionRecorded,
  recordPhaseDuration,
  recordReviewDecision,
  recordRevisionsPerPlan,
  updateActivePlansGauge,
} from "../metrics.js";

afterEach(() => _resetMetrics());

describe("plans metrics", () => {
  it("counters tolerate the meter not being initialized", () => {
    expect(() => recordReviewDecision("approved")).not.toThrow();
    expect(() => recordDecisionRecorded("p-1")).not.toThrow();
  });
  it("histograms tolerate the meter not being initialized", () => {
    expect(() => recordRevisionsPerPlan(3)).not.toThrow();
    expect(() => recordPhaseDuration("Research", 12345)).not.toThrow();
  });
  it("active-gauge updates store cleanly", () => {
    expect(() => updateActivePlansGauge("co-1", "in_progress", 4)).not.toThrow();
  });
});
