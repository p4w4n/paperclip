// OTel messaging-semconv (Stable 2026) spans for the work queue.
//
// Two spans:
//   paperclip.work_queue.create  — enqueue path
//   paperclip.work_queue.process — materialize path; the parent
//     of the existing gen_ai.agent.invoke span emitted by the run
//
// Attributes follow the Stable 2026 messaging convention:
//   messaging.system          = "paperclip-work-queue"
//   messaging.destination.name = <queue>
//   messaging.message.id       = <workItemId>
//   messaging.operation        = "create" | "process"
//   messaging.client_id        = <enqueuedByKind> (when set)
//
// Both helpers return the span so the caller can add attributes
// (e.g., dedupe_key on enqueue, gen_ai child relation on process)
// before ending it.

import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "paperclip.work_queue";

export interface WorkQueueSpanInput {
  workItemId: string;
  queue: string;
  enqueuedByKind?: string;
}

export function startCreateSpan(input: WorkQueueSpanInput): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan("paperclip.work_queue.create", {
    attributes: {
      "messaging.system": "paperclip-work-queue",
      "messaging.destination.name": input.queue,
      "messaging.message.id": input.workItemId,
      "messaging.operation": "create",
      ...(input.enqueuedByKind
        ? { "messaging.client_id": input.enqueuedByKind }
        : {}),
    },
  });
  return span;
}

export function startProcessSpan(input: WorkQueueSpanInput): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan("paperclip.work_queue.process", {
    attributes: {
      "messaging.system": "paperclip-work-queue",
      "messaging.destination.name": input.queue,
      "messaging.message.id": input.workItemId,
      "messaging.operation": "process",
    },
  });
  return span;
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
