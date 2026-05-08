# Server observability — OpenTelemetry

OpenTelemetry instrumentation for the control plane. Disabled by default; opt in via env vars.

## Quick start

### Local dev with console output

```sh
PAPERCLIP_OTEL_ENABLED=true \
PAPERCLIP_OTEL_EXPORTER=console \
pnpm dev
```

Spans pretty-print to stdout. Useful for "is my new manual span actually firing?"

### Production: ship to Google Cloud Trace

```sh
export PAPERCLIP_OTEL_ENABLED=true
export PAPERCLIP_OTEL_EXPORTER=cloud-trace
export PAPERCLIP_OTEL_SERVICE_NAME=paperclip-server
export PAPERCLIP_DEPLOYMENT_ENV=production
# Service account credentials (omit on GCE — falls back to metadata server)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
export GOOGLE_CLOUD_PROJECT=my-project-id
```

Required IAM role on the service account: `roles/cloudtrace.agent`.

Traces appear in the Cloud Trace console (`https://console.cloud.google.com/traces`) within ~1 minute of being emitted.

### Production: ship via OTLP/gRPC (Tempo, Honeycomb, Jaeger, OTel Collector)

```sh
export PAPERCLIP_OTEL_ENABLED=true
export PAPERCLIP_OTEL_EXPORTER=otlp-grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=https://my-collector.example.com:4317
# Optional: per-backend headers
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$KEY"
```

## What gets instrumented

### Auto

`@opentelemetry/auto-instrumentations-node` covers:

- **HTTP server / client** — every inbound request, every outgoing fetch / undici / http call
- **Express** — middleware spans (often noisy; disable per-instrumentation in `otel.ts` if needed)
- **PostgreSQL (`pg`)** — every query, with `db.statement` attribute
- **DNS, fs (disabled), redis, kafka, gRPC, etc.** — see `getNodeAutoInstrumentations` defaults

### Manual (paperclip-domain)

Manual spans are added in `./spans.ts` for paths where the auto-instrumentation gives the *technical* answer but not the *paperclip-domain* one. Currently:

- `paperclip.live_events.publish` — fires on every `publishLiveEvent`. Attributes: `paperclip.company_id`, `paperclip.event_type`, `paperclip.live_events.subscriber_count`.
- `paperclip.live_events.publish_global` — same, for company-less broadcasts.

To add more, import `withSpan` (async) or `withSyncSpan` (sync) from `./spans.ts`:

```ts
import { withSpan, PaperclipAttr } from "../observability/spans.js";

const result = await withSpan(
  "paperclip.heartbeat.dispatch",
  async (span) => {
    span.setAttribute("paperclip.attempt", attempt);
    return runDispatcher.dispatch(runId);
  },
  {
    [PaperclipAttr.AgentId]: agentId,
    [PaperclipAttr.RunId]: runId,
  },
);
```

The wrappers are no-ops when OTel isn't enabled — calling them with the SDK off costs one function call.

## Current gaps

The following are queued as follow-ups, not in v1:

- **Browser-side SDK.** `@opentelemetry/sdk-trace-web` + `@opentelemetry/instrumentation-fetch` would close the loop so a single trace spans `Dashboard.tsx → fetch → /api/companies/:id/dashboard → pg query`. Adds ~200 KB to the UI bundle; pair with code-splitting before shipping. Stub plan in `ui/src/observability/PLAN.md`.
- **Admin UI for trace summaries.** Cloud Trace and Jaeger have their own consoles, so a paperclip-side `/_perf` page is a nice-to-have, not a must. Defer.
- **`paperclip.heartbeat.dispatch`, `paperclip.heartbeat.tick`, `paperclip.budgets.check`** spans. The functions are deep / re-throw-prone, and naive wrapping changes control flow. Worth doing alongside the worker phase 1 work since the dispatch path will get refactored anyway.

## Why this lives separately from `server/src/telemetry.ts`

`telemetry.ts` is the upstream Paperclip anonymous-stats client (opt-in, periodic flush, ships to a paperclip-controlled endpoint). It is unrelated to OpenTelemetry. The two coexist:

- `telemetry.ts` → "how many times did anyone create an agent today" (product analytics)
- `observability/otel.ts` → "which span took 4 seconds during this user's request" (operational telemetry)

Different audiences, different lifetimes, different exporters.
