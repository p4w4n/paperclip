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

let cached: ReturnType<typeof metrics.getMeter> | null = null;
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
    cached = metrics.getMeter("paperclip.outcomes", "1.0.0");
    counters = {
      verifiedTotal: cached.createCounter("paperclip_outcome_verified_total", {
        description: "Outcomes that flipped from pending to verified",
      }),
      revertedTotal: cached.createCounter("paperclip_outcome_reverted_total", {
        description: "Outcomes that flipped from verified to reverted",
      }),
      gateBlockedTotal: cached.createCounter("paperclip_outcome_gate_blocked_total", {
        description: "Issue/plan terminal-state transitions blocked by 422 OutcomeRequiredError",
      }),
      signalReceivedTotal: cached.createCounter("paperclip_outcome_signal_received_total", {
        description: "external_signal webhook POSTs received (verified=true|false)",
      }),
      verifierErrorTotal: cached.createCounter("paperclip_outcome_verifier_error_total", {
        description: "Verifier errors caught by OutcomesService.tryVerify (logged, not surfaced)",
      }),
    };
    pendingGauge = cached.createObservableGauge("paperclip_outcome_pending_total", {
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
