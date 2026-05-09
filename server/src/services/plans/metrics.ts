// OTel metrics for the plans subsystem.
//
//   paperclip_plans_active{company,status}             gauge
//   paperclip_plan_revisions_per_plan                  histogram
//   paperclip_plan_review_decisions_total{decision}    counter
//   paperclip_plan_phase_duration_ms{name}             histogram
//   paperclip_plan_decisions_total{plan_id}            counter

import {
  metrics,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@opentelemetry/api";

let cached: ReturnType<typeof metrics.getMeter> | null = null;
let counters: {
  reviewDecisionTotal: Counter;
  decisionsTotal: Counter;
  revisionsPerPlan: Histogram;
  phaseDurationMs: Histogram;
} | null = null;
let activeGauge: ObservableGauge | null = null;

interface ActiveValue {
  companyId: string;
  status: string;
  count: number;
}
const activeValues = new Map<string, ActiveValue>();

function ensure() {
  if (counters) return counters;
  try {
    cached = metrics.getMeter("paperclip.plans", "1.0.0");
    counters = {
      reviewDecisionTotal: cached.createCounter(
        "paperclip_plan_review_decisions_total",
        { description: "Total plan review decisions, labeled by decision" },
      ),
      decisionsTotal: cached.createCounter("paperclip_plan_decisions_total", {
        description: "Total plan decisions recorded, labeled by plan id",
      }),
      revisionsPerPlan: cached.createHistogram(
        "paperclip_plan_revisions_per_plan",
        { description: "Revisions per plan at terminal" },
      ),
      phaseDurationMs: cached.createHistogram(
        "paperclip_plan_phase_duration_ms",
        { description: "Phase wall-clock duration", unit: "ms" },
      ),
    };
    activeGauge = cached.createObservableGauge("paperclip_plans_active", {
      description: "Active plans per (company, status)",
    });
    activeGauge.addCallback((observer) => {
      for (const v of activeValues.values()) {
        observer.observe(v.count, { company: v.companyId, status: v.status });
      }
    });
  } catch {
    counters = null;
  }
  return counters;
}

export function recordReviewDecision(decision: string): void {
  const c = ensure();
  if (!c) return;
  c.reviewDecisionTotal.add(1, { decision });
}

export function recordDecisionRecorded(planId: string): void {
  const c = ensure();
  if (!c) return;
  c.decisionsTotal.add(1, { plan_id: planId });
}

export function recordRevisionsPerPlan(value: number): void {
  const c = ensure();
  if (!c) return;
  c.revisionsPerPlan.record(value);
}

export function recordPhaseDuration(name: string, ms: number): void {
  const c = ensure();
  if (!c) return;
  c.phaseDurationMs.record(ms, { phase_name: name });
}

export function updateActivePlansGauge(
  companyId: string,
  status: string,
  count: number,
): void {
  ensure();
  activeValues.set(`${companyId}::${status}`, { companyId, status, count });
}

export function _resetMetrics(): void {
  activeValues.clear();
}
