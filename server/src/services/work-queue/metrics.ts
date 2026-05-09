// OTel metrics for the work-queue subsystem. Lazy-init the meter
// so we don't fail when OTel hasn't been booted.
//
// Per spec:
//   paperclip_work_queue_depth{company,queue}        — gauge (observable)
//   paperclip_work_queue_dequeue_latency_ms          — histogram
//   paperclip_work_queue_retry_total{retry_class}    — counter
//   paperclip_work_queue_dead_letter_count{company}  — gauge (observable)
//   paperclip_work_queue_fairness_drift{company}     — gauge (observable)
//
// The depth + DLQ + drift gauges are observable (registered
// callbacks); the scheduler tick provides the values via
// updateDepthGauge / updateDeadLetterGauge / updateFairnessDrift.

import {
  metrics,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@opentelemetry/api";

let cachedMeter: ReturnType<typeof metrics.getMeter> | null = null;
let counters: {
  retryTotal: Counter;
  dequeueLatencyMs: Histogram;
} | null = null;

let observableGauges: {
  depth: ObservableGauge;
  deadLetterCount: ObservableGauge;
  fairnessDrift: ObservableGauge;
} | null = null;

interface DepthValue {
  companyId: string;
  queue: string;
  value: number;
}

const depthValues = new Map<string, DepthValue>();
const deadLetterValues = new Map<string, number>();
const fairnessDriftValues = new Map<string, number>();

function ensureCounters() {
  if (counters) return counters;
  try {
    cachedMeter = metrics.getMeter("paperclip.work_queue", "1.0.0");
    counters = {
      retryTotal: cachedMeter.createCounter("paperclip_work_queue_retry_total", {
        description: "Total work-queue retries, labeled by retry_class",
      }),
      dequeueLatencyMs: cachedMeter.createHistogram(
        "paperclip_work_queue_dequeue_latency_ms",
        {
          description: "Milliseconds between enqueue and dequeue",
          unit: "ms",
        },
      ),
    };
    observableGauges = {
      depth: cachedMeter.createObservableGauge("paperclip_work_queue_depth", {
        description: "Queued items per (company, queue)",
      }),
      deadLetterCount: cachedMeter.createObservableGauge(
        "paperclip_work_queue_dead_letter_count",
        { description: "Dead-letter rows per company" },
      ),
      fairnessDrift: cachedMeter.createObservableGauge(
        "paperclip_work_queue_fairness_drift",
        {
          description:
            "Actual / expected dequeue ratio per company over a 5min rolling window",
        },
      ),
    };
    observableGauges.depth.addCallback((observer) => {
      for (const v of depthValues.values()) {
        observer.observe(v.value, { company: v.companyId, queue: v.queue });
      }
    });
    observableGauges.deadLetterCount.addCallback((observer) => {
      for (const [companyId, v] of deadLetterValues) {
        observer.observe(v, { company: companyId });
      }
    });
    observableGauges.fairnessDrift.addCallback((observer) => {
      for (const [companyId, v] of fairnessDriftValues) {
        observer.observe(v, { company: companyId });
      }
    });
  } catch {
    counters = null;
  }
  return counters;
}

export function recordRetry(retryClass: string): void {
  const c = ensureCounters();
  if (!c) return;
  c.retryTotal.add(1, { retry_class: retryClass });
}

export function recordDequeueLatency(ms: number): void {
  const c = ensureCounters();
  if (!c) return;
  c.dequeueLatencyMs.record(ms);
}

export function updateDepthGauge(companyId: string, queue: string, value: number): void {
  ensureCounters();
  depthValues.set(`${companyId}::${queue}`, { companyId, queue, value });
}

export function updateDeadLetterGauge(companyId: string, value: number): void {
  ensureCounters();
  deadLetterValues.set(companyId, value);
}

export function updateFairnessDrift(companyId: string, value: number): void {
  ensureCounters();
  fairnessDriftValues.set(companyId, value);
}

// Test-only.
export function _resetMetrics(): void {
  depthValues.clear();
  deadLetterValues.clear();
  fairnessDriftValues.clear();
}
