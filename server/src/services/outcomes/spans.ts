// OTel span helpers for the outcomes subsystem. Mirror the lazy-init
// pattern used by learning/spans.ts and plans/spans.ts.
//
// Spans:
//   paperclip.outcome.materialize_contract
//   paperclip.outcome.try_verify
//   paperclip.outcome.revert

import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "paperclip.outcomes";

export function startMaterializeContractSpan(
  targetKind: string,
  targetId: string,
): Span {
  return trace.getTracer(TRACER_NAME).startSpan("paperclip.outcome.materialize_contract", {
    attributes: {
      "outcome.target_kind": targetKind,
      "outcome.target_id": targetId,
    },
  });
}

export function startTryVerifySpan(kind: string): Span {
  return trace.getTracer(TRACER_NAME).startSpan("paperclip.outcome.try_verify", {
    attributes: { "outcome.kind": kind },
  });
}

export function startRevertSpan(outcomeId: string): Span {
  return trace.getTracer(TRACER_NAME).startSpan("paperclip.outcome.revert", {
    attributes: { "outcome.id": outcomeId },
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
