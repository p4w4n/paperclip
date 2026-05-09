import { describe, expect, it } from "vitest";
import {
  endSpanError,
  endSpanOk,
  startMineSpan,
  startPlaybookSpan,
  startSuggestSpan,
} from "../spans.js";

describe("learning spans", () => {
  it("each helper produces a span (no-op tracer when SDK absent)", () => {
    expect(startMineSpan("pattern")).toBeDefined();
    expect(startMineSpan("skill")).toBeDefined();
    expect(startMineSpan("decision_pattern")).toBeDefined();
    expect(startSuggestSpan("co-1")).toBeDefined();
    expect(startPlaybookSpan("create", "pb-1")).toBeDefined();
  });

  it("end helpers are safe to call", () => {
    const s = startMineSpan("pattern");
    expect(() => endSpanOk(s)).not.toThrow();
    const t = startSuggestSpan("co-1");
    expect(() => endSpanError(t, new Error("oops"))).not.toThrow();
  });
});
