# Browser-side OpenTelemetry — implementation plan

The server-side OTel SDK (`server/src/observability/`) gives traces for every API request, pg query, and a starting set of paperclip-domain spans. What's missing is the **client-side half** of the trace: a single trace ID that spans `Dashboard.tsx onClick → fetch → server route → pg query → response → React commit`.

This file outlines what that takes. It's not in v1 because:

- It adds ~200 KB to the UI bundle (already a concern after perf #6 left a +28% FCP regression).
- For Cloud Trace specifically, browser → Cloud Trace requires either a Cloud Endpoints proxy or an OTel Collector — the v1 server-only setup avoids that piece of infra.
- Server-side traces alone answer ~80% of "what's slow" questions. Client-side closes the loop on the remaining 20%.

Worth doing once the worker plan is mid-flight and "I clicked X and it took 4 seconds" complaints can no longer be diagnosed from server traces alone.

## Sketch of the work

### 1. Dependencies (~5 packages, ~200 KB gzipped)

```sh
pnpm add --filter @paperclipai/ui \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-web \
  @opentelemetry/instrumentation-fetch \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/context-zone
```

### 2. `ui/src/observability/otel.ts`

Mirrors the server module:

- `initBrowserOpenTelemetry()` — opt-in via `import.meta.env.VITE_OTEL_ENABLED === "true"`.
- Endpoint via `import.meta.env.VITE_OTEL_ENDPOINT` (typically an OTel collector URL).
- Context manager: `ZoneContextManager` so async ops carry trace context correctly.
- Auto-instrumentation: `FetchInstrumentation` for outbound fetch — every API call gets a span and propagates `traceparent` header.
- Manual spans: wrap critical user interactions via a `useObservedRender` hook.

### 3. Server endpoint to receive client OTLP

Two options:

- **Standalone OTel Collector** sidecar (simplest). Configure with the same exporters as the server SDK.
- **Server proxy endpoint** — `POST /api/_otel/trace` accepts OTLP/HTTP and forwards through the existing Cloud Trace exporter. Avoids running a separate process; harder to get right.

Recommend the collector for v1.

### 4. Trace context propagation

The biggest gotcha. The browser SDK adds a `traceparent` header to outbound fetches automatically — server-side `@opentelemetry/instrumentation-http` reads it and continues the trace. End-to-end works **as long as the server's CORS config allows the `traceparent` header**. Audit `server/src/app.ts`'s CORS middleware before flipping the browser SDK on.

### 5. React component render timing

Wrap top-level routes in `<Profiler onRender>` and emit OTel spans for slow commits (e.g., `> 50 ms`). Sample rate to keep volume bounded. The existing `perf/scenarios/chat-scroll.mjs` Profiler instrumentation is a model.

A `useObservedRender` hook in `ui/src/observability/spans.ts` would centralize the pattern.

### 6. `performance.memory` snapshots (Chrome only)

Optional. Periodic snapshots (every 30s, on visibility change, on route change) attached as span events on a long-running "session" span. Tells you whether a particular page leaks.

## Recommended sequence

1. Set up an OTel Collector (or Honeycomb account, etc.) so there's somewhere to send data.
2. Add `initBrowserOpenTelemetry` and wire into `ui/src/main.tsx` before `createRoot()`.
3. Verify a fetch creates a trace that reaches the backend with the same trace ID.
4. Add the `<Profiler>` wrapper around routes; sample slow commits.
5. Iterate on attribute keys (`paperclip.route`, `paperclip.user_id`, etc.).

One focused day for someone familiar with OTel browser SDK; longer for someone new to it.
