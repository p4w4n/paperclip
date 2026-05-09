// OTel span helpers for the org-learning subsystem. Lazy-init via
// the global tracer; no-op when SDK isn't booted.

import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "paperclip.learning";

export function startMineSpan(stage: "pattern" | "skill" | "decision_pattern"): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan(`paperclip.learning.${stage}.mine`, {});
}

export function startSuggestSpan(companyId: string): Span {
  return trace.getTracer(TRACER_NAME).startSpan("paperclip.learning.suggest", {
    attributes: { "paperclip.company_id": companyId },
  });
}

export function startPlaybookSpan(
  op: "create" | "revise" | "approve" | "archive",
  playbookId: string,
): Span {
  return trace.getTracer(TRACER_NAME).startSpan(`paperclip.learning.playbook.${op}`, {
    attributes: { "paperclip.playbook.id": playbookId },
  });
}

export function endSpanOk(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}
export function endSpanError(span: Span, err: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
  span.end();
}
