import { describe, expect, it } from "vitest";
import { endSpanError, endSpanOk, startCreateSpan, startProcessSpan } from "../spans.js";

describe("work-queue spans", () => {
  it("startCreateSpan produces a span (defaulted no-op when SDK absent)", () => {
    const span = startCreateSpan({ workItemId: "wi-1", queue: "default" });
    expect(span).toBeDefined();
    endSpanOk(span);
  });

  it("startProcessSpan + endSpanError handle error path", () => {
    const span = startProcessSpan({ workItemId: "wi-2", queue: "default" });
    expect(span).toBeDefined();
    endSpanError(span, new Error("boom"));
  });
});
