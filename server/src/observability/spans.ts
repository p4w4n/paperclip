// Manual span helpers for paperclip-specific hot paths. The auto-
// instrumentations cover HTTP / Express / pg / fetch / etc. — but the
// places that actually answer "why is this slow?" are the inner control-
// plane operations: heartbeat dispatch, WebSocket event handling, secret
// resolution, and budget checks. Wrap those manually so traces show the
// *paperclip-domain* causes of slowness, not just the underlying tech
// stack.
//
// Usage:
//
//   import { withSpan } from "./observability/spans.js";
//
//   await withSpan("paperclip.heartbeat.dispatch", async (span) => {
//     span.setAttribute("paperclip.agent_id", agentId);
//     return runDispatcher.dispatch(...);
//   });
//
// `withSpan` is a no-op when OTel isn't initialized (returns the inner
// function's result directly with no overhead beyond a function call).

import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

const tracer = trace.getTracer("paperclip-server", "0");

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) {
        for (const [k, v] of Object.entries(attributes)) {
          if (v !== undefined) span.setAttribute(k, v as string | number | boolean);
        }
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Synchronous variant for tight inner loops where async wrapping would
// add overhead disproportionate to the operation being measured. Use
// sparingly; most callers should reach for `withSpan`.
export function withSyncSpan<T>(
  name: string,
  fn: (span: Span) => T,
  attributes?: Record<string, string | number | boolean | undefined>,
): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      if (attributes) {
        for (const [k, v] of Object.entries(attributes)) {
          if (v !== undefined) span.setAttribute(k, v as string | number | boolean);
        }
      }
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Standard attribute name for paperclip-specific dimensions. Keep keys
// kebab-cased and prefixed `paperclip.` so they sort cleanly next to OTel
// semantic-convention keys in trace backends.
export const PaperclipAttr = {
  CompanyId: "paperclip.company_id",
  AgentId: "paperclip.agent_id",
  RunId: "paperclip.run_id",
  IssueId: "paperclip.issue_id",
  AdapterType: "paperclip.adapter_type",
  EventType: "paperclip.event_type",
  WorkerId: "paperclip.worker_id",
  Outcome: "paperclip.outcome",
} as const;
