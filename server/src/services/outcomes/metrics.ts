// OTel metrics for the outcomes subsystem.
//
//   paperclip_outcome_pending_total{kind, target_kind}        observable gauge
//   paperclip_outcome_verified_total{kind}                    counter
//   paperclip_outcome_reverted_total{kind, reason_class}      counter
//   paperclip_outcome_gate_blocked_total{target_kind}         counter
//   paperclip_outcome_signal_received_total{verified}         counter
//   paperclip_outcome_verifier_error_total{kind}              counter  (error path)

import {
  metrics,
  type Counter,
  type ObservableGauge,
} from "@opentelemetry/api";

// Shared meter for the outcomes subsystem — reused by both P1 and P2 counters.
const meter = metrics.getMeter("paperclip.outcomes", "1.0.0");

let counters: {
  verifiedTotal: Counter;
  revertedTotal: Counter;
  gateBlockedTotal: Counter;
  signalReceivedTotal: Counter;
  verifierErrorTotal: Counter;
} | null = null;
let pendingGauge: ObservableGauge | null = null;

// Map keyed by "kind|target_kind" -> count.
// Updated externally via updatePendingGauge().
let pendingCounts = new Map<string, number>();

function ensure() {
  if (counters) return counters;
  try {
    counters = {
      verifiedTotal: meter.createCounter("paperclip_outcome_verified_total", {
        description: "Outcomes that flipped from pending to verified",
      }),
      revertedTotal: meter.createCounter("paperclip_outcome_reverted_total", {
        description: "Outcomes that flipped from verified to reverted",
      }),
      gateBlockedTotal: meter.createCounter("paperclip_outcome_gate_blocked_total", {
        description: "Issue/plan terminal-state transitions blocked by 422 OutcomeRequiredError",
      }),
      signalReceivedTotal: meter.createCounter("paperclip_outcome_signal_received_total", {
        description: "external_signal webhook POSTs received (verified=true|false)",
      }),
      verifierErrorTotal: meter.createCounter("paperclip_outcome_verifier_error_total", {
        description: "Verifier errors caught by OutcomesService.tryVerify (logged, not surfaced)",
      }),
    };
    pendingGauge = meter.createObservableGauge("paperclip_outcome_pending_total", {
      description: "Pending outcomes by kind + target_kind",
    });
    pendingGauge.addCallback((observer) => {
      for (const [labelKey, value] of pendingCounts) {
        const [kind, targetKind] = labelKey.split("|");
        observer.observe(value, { kind, target_kind: targetKind });
      }
    });
  } catch {
    counters = null;
  }
  return counters;
}

// ---------------------------------------------------------------------------
// Helper functions called by OutcomesService and route handlers
// ---------------------------------------------------------------------------

export function recordVerified(kind: string): void {
  const c = ensure();
  if (!c) return;
  c.verifiedTotal.add(1, { kind });
}

export function recordReverted(kind: string, reasonClass: string): void {
  const c = ensure();
  if (!c) return;
  c.revertedTotal.add(1, { kind, reason_class: reasonClass });
}

export function recordGateBlocked(targetKind: string): void {
  const c = ensure();
  if (!c) return;
  c.gateBlockedTotal.add(1, { target_kind: targetKind });
}

export function recordSignalReceived(verified: boolean): void {
  const c = ensure();
  if (!c) return;
  c.signalReceivedTotal.add(1, { verified: String(verified) });
}

export function recordVerifierError(kind: string): void {
  const c = ensure();
  if (!c) return;
  c.verifierErrorTotal.add(1, { kind });
}

/** Update the in-process pending counts; called after materializeContract or from a periodic refresh. */
export function updatePendingGauge(map: Map<string, number>): void {
  ensure(); // ensure gauge callback is registered
  pendingCounts = map;
}

export function _resetMetrics(): void {
  pendingCounts = new Map();
}

// ---------------------------------------------------------------------------
// Plan 2 counters — 8 new metric streams.
// ---------------------------------------------------------------------------

export const templateAppliedCounter = meter.createCounter(
  "paperclip_outcome_template_applied_total",
  { description: "Plan templates applied to plans" },
);
export const webhookReceivedCounter = meter.createCounter(
  "paperclip_outcome_webhook_received_total",
  { description: "External webhooks received (by source + result)" },
);
export const webhookSignatureFailedCounter = meter.createCounter(
  "paperclip_outcome_webhook_signature_failed_total",
  { description: "Webhook signature failures (security-critical)" },
);
export const playbookAppliedCounter = meter.createCounter(
  "paperclip_outcome_playbook_applied_total",
  { description: "Playbooks applied to issues (governance automation)" },
);
export const autoReopenCounter = meter.createCounter(
  "paperclip_outcome_auto_reopen_total",
  { description: "Auto-reopen on outcome revert" },
);
export const autoReopenFailedCounter = meter.createCounter(
  "paperclip_outcome_auto_reopen_failed_total",
  { description: "Auto-reopen attempts that errored (best-effort)" },
);
export const autoReopenSuppressedCounter = meter.createCounter(
  "paperclip_outcome_auto_reopen_suppressed_total",
  { description: "Auto-reopen suppressed (alternative still covered slot)" },
);
export const aliasSlotSatisfiedCounter = meter.createCounter(
  "paperclip_outcome_alias_slot_satisfied_total",
  { description: "Alias slots satisfied (by primary or alternative)" },
);

// ---------------------------------------------------------------------------
// Auto-reopen helpers — replaced from Task-11 stubs with real counter calls.
// ---------------------------------------------------------------------------

export function recordAutoReopen(labels: { kind: string; target_kind: string }): void {
  autoReopenCounter.add(1, labels);
}
export function recordAutoReopenFailed(labels: { kind: string; target_kind: string; reason_class: string }): void {
  autoReopenFailedCounter.add(1, labels);
}
export function recordAutoReopenSuppressed(labels: { reason: string }): void {
  autoReopenSuppressedCounter.add(1, labels);
}

// ---------------------------------------------------------------------------
// Convenience helpers for new metric streams.
// ---------------------------------------------------------------------------

export function recordTemplateApplied(labels: { template_id_low_card: string }): void {
  templateAppliedCounter.add(1, labels);
}
export function recordWebhookReceived(labels: { source: string; result: string }): void {
  webhookReceivedCounter.add(1, labels);
}
export function recordWebhookSignatureFailed(labels: { source: string }): void {
  webhookSignatureFailedCounter.add(1, labels);
}
export function recordPlaybookApplied(labels: { playbook_id_low_card: string; added_count_bucket: string }): void {
  playbookAppliedCounter.add(1, labels);
}
