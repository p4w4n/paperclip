// In-process registry of run-completion promises. The dispatch-or-local
// adapter wrapper calls awaitRunCompletion(runId) and gets back a
// promise; the worker-rpc connect-handler calls settleRunCompletion
// when the worker reports RunComplete or RunFailed on the bidi stream.
//
// Lives in-memory on the control plane. If the control plane restarts
// while a run is in flight, the promise is lost — the lease reaper
// (Task 12) marks the run failed and re-queues based on
// heartbeat_runs.lease_expires_at, which is the persistent companion to
// this in-memory state.
//
// Concurrency: Node single-threaded; settle and await never race within
// a single tick. Idempotent settle: calling settleRunCompletion twice
// for the same runId is harmless because the second lookup gets
// undefined and bails.

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

interface Pending {
  resolve: (r: AdapterExecutionResult) => void;
  reject: (e: Error) => void;
}

const pending = new Map<string, Pending>();

export function awaitRunCompletion(runId: string): Promise<AdapterExecutionResult> {
  // If something already registered a pending entry for this runId
  // (would only happen if the same run gets dispatched twice without
  // settle in between — a bug, but guard anyway), reject the prior
  // waiter so it doesn't dangle forever.
  const prior = pending.get(runId);
  if (prior) {
    pending.delete(runId);
    prior.reject(new Error(`run ${runId} re-registered before completion`));
  }
  return new Promise<AdapterExecutionResult>((resolve, reject) => {
    pending.set(runId, { resolve, reject });
  });
}

export function settleRunCompletion(
  runId: string,
  result: AdapterExecutionResult | Error,
): void {
  const p = pending.get(runId);
  if (!p) return;
  pending.delete(runId);
  if (result instanceof Error) p.reject(result);
  else p.resolve(result);
}

// For tests / shutdown — drops every pending waiter as rejected.
export function clearAllPendingForTest(): void {
  for (const [runId, p] of pending) {
    p.reject(new Error(`pending wait for ${runId} cleared`));
  }
  pending.clear();
}
