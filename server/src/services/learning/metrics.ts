// OTel metrics for the org-learning subsystem.
//
//   paperclip_playbooks_active{company,status}            gauge
//   paperclip_outcome_patterns_total{company}             counter
//   paperclip_agent_skills_total{company}                 counter
//   paperclip_learning_suggest_latency_ms                 histogram
//   paperclip_learning_suggest_match_score                histogram
//   paperclip_learning_pattern_promotion_total            counter

import {
  metrics,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@opentelemetry/api";

let cached: ReturnType<typeof metrics.getMeter> | null = null;
let counters: {
  outcomePatternsTotal: Counter;
  agentSkillsTotal: Counter;
  patternPromotionTotal: Counter;
  suggestLatencyMs: Histogram;
  suggestMatchScore: Histogram;
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
    cached = metrics.getMeter("paperclip.learning", "1.0.0");
    counters = {
      outcomePatternsTotal: cached.createCounter("paperclip_outcome_patterns_total", {
        description: "Outcome patterns mined per company",
      }),
      agentSkillsTotal: cached.createCounter("paperclip_agent_skills_total", {
        description: "Agent skills derived per company",
      }),
      patternPromotionTotal: cached.createCounter(
        "paperclip_learning_pattern_promotion_total",
        { description: "Outcome patterns promoted to playbooks" },
      ),
      suggestLatencyMs: cached.createHistogram(
        "paperclip_learning_suggest_latency_ms",
        { description: "suggestPlaybooks call latency", unit: "ms" },
      ),
      suggestMatchScore: cached.createHistogram(
        "paperclip_learning_suggest_match_score",
        { description: "Match scores returned by suggestPlaybooks (for tuning the threshold)" },
      ),
    };
    activeGauge = cached.createObservableGauge("paperclip_playbooks_active", {
      description: "Active playbooks per (company, status)",
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

export function recordOutcomePattern(companyId: string): void {
  const c = ensure();
  if (!c) return;
  c.outcomePatternsTotal.add(1, { company: companyId });
}

export function recordAgentSkill(companyId: string): void {
  const c = ensure();
  if (!c) return;
  c.agentSkillsTotal.add(1, { company: companyId });
}

export function recordPatternPromotion(companyId: string): void {
  const c = ensure();
  if (!c) return;
  c.patternPromotionTotal.add(1, { company: companyId });
}

export function recordSuggestLatency(ms: number): void {
  const c = ensure();
  if (!c) return;
  c.suggestLatencyMs.record(ms);
}

export function recordSuggestMatchScore(score: number): void {
  const c = ensure();
  if (!c) return;
  c.suggestMatchScore.record(score);
}

export function updatePlaybooksActiveGauge(
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
