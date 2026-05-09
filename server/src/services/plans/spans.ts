// OTel span helpers for the plans subsystem. Mirror the lazy-init
// pattern used by artifacts/spans.ts and work-queue/spans.ts.
//
// Spans:
//   paperclip.plan.create
//   paperclip.plan.revise
//   paperclip.plan.review_decision  (decision attribute)
//   paperclip.plan.phase.start
//   paperclip.plan.phase.complete
//   paperclip.plan.decision.record

import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "paperclip.plans";

export function startCreateSpan(planId: string): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan("paperclip.plan.create", {
      attributes: { "plan.id": planId },
    });
}

export function startReviseSpan(planId: string, revisionNumber: number): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan("paperclip.plan.revise", {
      attributes: { "plan.id": planId, "plan.revision_number": revisionNumber },
    });
}

export function startReviewDecisionSpan(
  planId: string,
  decision: string,
): Span {
  return trace.getTracer(TRACER_NAME).startSpan("paperclip.plan.review_decision", {
    attributes: { "plan.id": planId, "plan.review.decision": decision },
  });
}

export function startPhaseStartSpan(phaseId: string): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan("paperclip.plan.phase.start", {
      attributes: { "plan.phase.id": phaseId },
    });
}

export function startPhaseCompleteSpan(phaseId: string): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan("paperclip.plan.phase.complete", {
      attributes: { "plan.phase.id": phaseId },
    });
}

export function startDecisionRecordSpan(planId: string): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan("paperclip.plan.decision.record", {
      attributes: { "plan.id": planId },
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
