// OTel metrics for the artifacts subsystem. Lazy-init the meter so
// we don't fail when OTel hasn't been booted (tests, embedded
// runs). Counters per spec:
//   paperclip_artifacts_declared_total{kind}
//   paperclip_artifact_blob_bytes_total{provider}
//   paperclip_artifact_preview_active_count (gauge)
//   paperclip_artifact_preview_materialize_latency_ms (histogram)
//
// All emitters tolerate the meter not being available — they
// no-op silently. Production wires the meter via the existing
// initOpenTelemetry() entry point.

import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

let cachedMeter: ReturnType<typeof metrics.getMeter> | null = null;
let counters: {
  declaredTotal: Counter;
  blobBytesTotal: Counter;
  previewMaterializeLatencyMs: Histogram;
} | null = null;

function ensureCounters() {
  if (counters) return counters;
  try {
    cachedMeter = metrics.getMeter("paperclip.artifacts", "1.0.0");
    counters = {
      declaredTotal: cachedMeter.createCounter("paperclip_artifacts_declared_total", {
        description: "Number of artifacts declared, labeled by kind",
      }),
      blobBytesTotal: cachedMeter.createCounter("paperclip_artifact_blob_bytes_total", {
        description: "Bytes of artifact blobs uploaded, labeled by storage provider",
        unit: "By",
      }),
      previewMaterializeLatencyMs: cachedMeter.createHistogram(
        "paperclip_artifact_preview_materialize_latency_ms",
        {
          description: "Latency of preview-provider materialize calls",
          unit: "ms",
        },
      ),
    };
  } catch {
    counters = null;
  }
  return counters;
}

export function recordArtifactDeclared(kind: string): void {
  const c = ensureCounters();
  if (!c) return;
  c.declaredTotal.add(1, { kind });
}

export function recordArtifactBlobBytes(provider: string, bytes: number): void {
  const c = ensureCounters();
  if (!c) return;
  c.blobBytesTotal.add(bytes, { provider });
}

export function recordPreviewMaterializeLatency(provider: string, ms: number): void {
  const c = ensureCounters();
  if (!c) return;
  c.previewMaterializeLatencyMs.record(ms, { provider });
}
