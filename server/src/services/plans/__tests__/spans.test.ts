import { describe, expect, it } from "vitest";
import {
  endSpanError,
  endSpanOk,
  startCreateSpan,
  startDecisionRecordSpan,
  startPhaseCompleteSpan,
  startPhaseStartSpan,
  startReviewDecisionSpan,
  startReviseSpan,
} from "../spans.js";

describe("plans spans", () => {
  it("each helper produces a span (defaulted no-op when SDK absent)", () => {
    expect(startCreateSpan("p-1")).toBeDefined();
    expect(startReviseSpan("p-1", 2)).toBeDefined();
    expect(startReviewDecisionSpan("p-1", "approved")).toBeDefined();
    expect(startPhaseStartSpan("ph-1")).toBeDefined();
    expect(startPhaseCompleteSpan("ph-1")).toBeDefined();
    expect(startDecisionRecordSpan("p-1")).toBeDefined();
  });
  it("end helpers are safe to call", () => {
    const s = startCreateSpan("p-1");
    expect(() => endSpanOk(s)).not.toThrow();
    const t = startCreateSpan("p-2");
    expect(() => endSpanError(t, new Error("oops"))).not.toThrow();
  });
});
