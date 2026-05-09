import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMetrics,
  recordAgentSkill,
  recordOutcomePattern,
  recordPatternPromotion,
  recordSuggestLatency,
  recordSuggestMatchScore,
  updatePlaybooksActiveGauge,
} from "../metrics.js";

afterEach(() => _resetMetrics());

describe("learning metrics", () => {
  it("counters tolerate the meter not being initialized", () => {
    expect(() => recordOutcomePattern("co-1")).not.toThrow();
    expect(() => recordAgentSkill("co-1")).not.toThrow();
    expect(() => recordPatternPromotion("co-1")).not.toThrow();
  });
  it("histograms tolerate the meter not being initialized", () => {
    expect(() => recordSuggestLatency(15)).not.toThrow();
    expect(() => recordSuggestMatchScore(0.45)).not.toThrow();
  });
  it("active-gauge updates store cleanly", () => {
    expect(() => updatePlaybooksActiveGauge("co-1", "active", 4)).not.toThrow();
  });
});
