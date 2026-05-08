// OpenTelemetry SDK initialization for the control plane.
//
// Disabled by default. Enable by setting `PAPERCLIP_OTEL_ENABLED=true` plus
// at least one exporter:
//
//   - `PAPERCLIP_OTEL_EXPORTER=cloud-trace` — ships to Google Cloud Trace
//     using @google-cloud/opentelemetry-cloud-trace-exporter. Picks up
//     credentials from GOOGLE_APPLICATION_CREDENTIALS or the GCE metadata
//     server. Project id is read from GOOGLE_CLOUD_PROJECT or auto-detected.
//   - `PAPERCLIP_OTEL_EXPORTER=otlp-grpc` — ships to any OTLP/gRPC endpoint
//     (Tempo, Honeycomb, Jaeger, OTel Collector). Endpoint via
//     OTEL_EXPORTER_OTLP_ENDPOINT (default `http://localhost:4317`).
//   - `PAPERCLIP_OTEL_EXPORTER=console` — pretty-prints spans to stdout.
//     Useful in dev.
//
// The SDK MUST be initialized before importing any auto-instrumented module.
// This file is imported at the very top of `server/src/index.ts` to satisfy
// that. Auto-instrumentations cover Express, HTTP, pg, fs, dns, undici,
// fetch, ioredis, etc. Manual spans for paperclip-specific hot paths
// (WS event handling, heartbeat dispatch, secret fetch) are added in
// `./spans.ts`.
//
// This is opt-in observability. With `PAPERCLIP_OTEL_ENABLED=false` (the
// default) the SDK is never started and the runtime cost is one cheap
// boolean check at startup.

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ConsoleSpanExporter, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

let sdk: NodeSDK | null = null;
let initAttempted = false;

function buildExporter(kind: string): SpanExporter | null {
  switch (kind) {
    case "console":
      return new ConsoleSpanExporter();
    case "otlp-grpc": {
      // Lazy require so the import isn't paid when this exporter isn't used.
      const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
      return new OTLPTraceExporter();
    }
    case "cloud-trace": {
      const { TraceExporter } = require("@google-cloud/opentelemetry-cloud-trace-exporter");
      return new TraceExporter();
    }
    default:
      return null;
  }
}

export function initOpenTelemetry(serviceVersion: string): void {
  if (initAttempted) return;
  initAttempted = true;

  if (process.env.PAPERCLIP_OTEL_ENABLED !== "true") return;

  if (process.env.PAPERCLIP_OTEL_DEBUG === "true") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const exporterKind = process.env.PAPERCLIP_OTEL_EXPORTER ?? "console";
  const exporter = buildExporter(exporterKind);
  if (!exporter) {
    // eslint-disable-next-line no-console
    console.warn(
      `[otel] Unknown exporter kind '${exporterKind}'. Disabling telemetry. ` +
        `Set PAPERCLIP_OTEL_EXPORTER to one of: cloud-trace, otlp-grpc, console.`,
    );
    return;
  }

  // Resource attributes describe the producer of the spans; Cloud Trace and
  // most backends key dashboards on `service.name`.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.PAPERCLIP_OTEL_SERVICE_NAME ?? "paperclip-server",
    [ATTR_SERVICE_VERSION]: serviceVersion,
    "deployment.environment": process.env.PAPERCLIP_DEPLOYMENT_ENV ?? "local",
  });

  sdk = new NodeSDK({
    resource,
    spanProcessor: new BatchSpanProcessor(exporter),
    // Auto-instrumentations cover Express, HTTP, pg, dns, fs, fetch, undici,
    // ioredis, and more. Tune the list via env later if a specific
    // instrumentation gets noisy.
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation produces a lot of low-value spans.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Express request spans get nicely augmented by the http
        // instrumentation; the inner Express layer is mostly noise.
        "@opentelemetry/instrumentation-express": { enabled: true },
      }),
    ],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[otel] OpenTelemetry started with exporter=${exporterKind} service=paperclip-server`);
}

export async function shutdownOpenTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[otel] shutdown failed:", err);
  } finally {
    sdk = null;
  }
}
