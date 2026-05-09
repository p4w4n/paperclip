import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMetrics,
  recordDequeueLatency,
  recordRetry,
  updateDeadLetterGauge,
  updateDepthGauge,
  updateFairnessDrift,
} from "../metrics.js";

afterEach(() => _resetMetrics());

describe("work-queue metrics", () => {
  it("recordRetry tolerates the meter not being initialized", () => {
    expect(() => recordRetry("transient_provider")).not.toThrow();
  });

  it("recordDequeueLatency tolerates the meter not being initialized", () => {
    expect(() => recordDequeueLatency(123)).not.toThrow();
  });

  it("update*Gauge stores values without throwing", () => {
    expect(() => updateDepthGauge("co-1", "default", 7)).not.toThrow();
    expect(() => updateDeadLetterGauge("co-1", 2)).not.toThrow();
    expect(() => updateFairnessDrift("co-1", 0.8)).not.toThrow();
  });
});
