// Server-side run dispatcher. Picks a worker from the registry, sends the
// RunDispatch frame on the worker's bidi stream, and tracks the run-to-
// worker assignment so completion / cancellation can release the slot.
//
// What this *doesn't* do (yet):
// - Persist the assignment to heartbeat_runs (Task 10 wires the
//   dispatch-or-local wrapper that updates lease columns).
// - Handle re-dispatch on lease expiry (Task 12 + lease reaper).
// - Queue runs when no worker is available (current contract: caller
//   gets dispatched=false and decides what to do — usually retry on
//   the next scheduler tick).
//
// Concurrency: pickFor → reserveSlot → send happens within a single
// async boundary. Because Node is single-threaded and we don't yield the
// event loop between pickFor and reserveSlot, two concurrent dispatches
// can't double-pick the same worker. The send() can yield, but the slot
// is already reserved at that point.

import { create } from "@bufbuild/protobuf";
import { ServerToWorkerSchema, RunDispatchSchema } from "@paperclipai/worker-rpc";
import type { WorkerRegistry } from "./worker-registry.js";

export interface DispatchInput {
  runId: string;
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  executionWorkspace: Record<string, unknown>;
  secretsScopeToken: string;
  sessionRestore?: Uint8Array;
  leaseSeconds: number;
}

export interface DispatchReceipt {
  dispatched: boolean;
  workerId?: string;
  reason?: string;
}

// Lease settlement signals. The dispatch-or-local wrapper subscribes via
// onSettlement so a lease_expired result can be reflected back to the
// dispatch-or-local awaiter as a thrown error (the wrapper's
// awaitCompletion() rejects, in-process state cleans up, the agent's
// run record is marked failed by the lease reaper in plan 2).
export type SettlementReason =
  | { kind: "complete"; payload?: unknown }
  | { kind: "failed"; payload?: unknown }
  | { kind: "lease_expired" };

export type SettlementListener = (runId: string, reason: SettlementReason) => void;

// Hook the production wiring uses to write `lease_expires_at` and
// `dispatched_to_worker_id` onto the heartbeat_runs row. Plan 2 Task 2's
// lease reaper scans those columns after a control-plane restart, so
// every dispatch + completion needs to be reflected on the row.
//
// Optional and called fire-and-forget on purpose: a failing DB write
// must not stall the dispatch path. Errors get surfaced via the
// callback's own error-handling (production wires a logger.warn); the
// reaper tolerates a one-cycle drift if a write was lost because it
// re-scans every 30s and lease windows default to 300s.
//
// We deliberately do NOT call this from touchLease/armLease keepalive
// resets — that would be a row update per worker frame (every
// leaseSeconds/3). The reaper's tolerance window absorbs the difference
// between in-memory deadline and persisted deadline.
export interface PersistLeaseInput {
  runId: string;
  workerId: string | null;
  leaseExpiresAt: Date | null;
}

export interface RunDispatcherOpts {
  persistLease?: (input: PersistLeaseInput) => Promise<void>;
}

export class RunDispatcher {
  // runId → workerId. Source of truth for "which worker did I send this
  // run to?" so markCompleted / markFailed know which slot to release.
  // The DB's heartbeat_runs.dispatched_to_worker_id is the persistent
  // companion; this map covers in-process state for the duration of
  // the dispatch lifecycle.
  private runToWorker = new Map<string, string>();
  // Per-run lease deadline timers. Cleared on markCompleted; rearmed by
  // touchLease (worker frame referencing the run) and extendLease
  // (server-issued grant extension).
  private leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Captured lease window per run so touchLease can reset to the
  // original duration without callers having to remember it.
  private leaseWindowSec = new Map<string, number>();
  private listeners = new Set<SettlementListener>();

  constructor(
    private readonly registry: WorkerRegistry,
    private readonly opts: RunDispatcherOpts = {},
  ) {}

  private persistLeaseFn?: (input: PersistLeaseInput) => Promise<void>;

  /**
   * Boot-time hook so the singleton instance (constructed at module load
   * before the DB handle exists) can be wired with the production
   * persist callback once the server has its Drizzle handle. Tests that
   * construct their own RunDispatcher pass `persistLease` via opts and
   * never call this.
   */
  setPersistLease(persist: (input: PersistLeaseInput) => Promise<void>): void {
    this.persistLeaseFn = persist;
  }

  private firePersist(input: PersistLeaseInput): void {
    const p = this.opts.persistLease ?? this.persistLeaseFn;
    if (!p) return;
    // Fire-and-forget: errors must not stall the dispatch / completion
    // path. The production wire passes a logger.warn-on-throw closure so
    // failures are visible without crashing the request.
    void p(input).catch(() => {
      /* logged inside the closure */
    });
  }

  async tryDispatch(input: DispatchInput): Promise<DispatchReceipt> {
    const worker = this.registry.pickFor(input.adapterType);
    if (!worker) return { dispatched: false, reason: "no worker available" };

    // Reserve before send so a concurrent pickFor can't choose the same
    // worker again while this send() is awaiting.
    this.registry.reserveSlot(worker.workerId);
    this.runToWorker.set(input.runId, worker.workerId);

    const frame = create(ServerToWorkerSchema, {
      payload: {
        case: "runDispatch",
        value: create(RunDispatchSchema, {
          runId: input.runId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          // adapterConfig and executionWorkspace are passed as JSON bytes
          // to keep the proto independent of evolving config shapes; the
          // worker decodes them with its own knowledge of the adapter.
          adapterConfigJson: new TextEncoder().encode(JSON.stringify(input.adapterConfig)),
          executionWorkspaceJson: new TextEncoder().encode(JSON.stringify(input.executionWorkspace)),
          secretsScopeToken: input.secretsScopeToken,
          sessionRestore: input.sessionRestore ?? new Uint8Array(),
          leaseSeconds: input.leaseSeconds,
        }),
      },
    });

    try {
      await worker.send(frame);
    } catch (err) {
      // send failed — the worker was registered when we picked it but
      // its stream is now broken. Roll back the reservation so the next
      // dispatch attempt can pick a different worker.
      this.registry.releaseSlot(worker.workerId);
      this.runToWorker.delete(input.runId);
      return { dispatched: false, reason: `send failed: ${(err as Error).message}` };
    }

    // Arm the lease deadline. Spec NOTE N2: the worker is required to
    // send a renewing frame (RunLog/Usage/Session/RunLeaseRenew) every
    // lease_seconds/3 — any of those frames calls touchLease() via
    // the connect handler. Missing the deadline triggers
    // lease_expired settlement and slot release.
    this.armLease(input.runId, input.leaseSeconds);

    // Persist the deadline + assigned worker so the reaper can recover
    // this run after a control-plane restart. Fire-and-forget — see
    // RunDispatcherOpts for the rationale.
    const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000);
    this.firePersist({ runId: input.runId, workerId: worker.workerId, leaseExpiresAt });

    return { dispatched: true, workerId: worker.workerId };
  }

  private armLease(runId: string, seconds: number): void {
    const old = this.leaseTimers.get(runId);
    if (old) clearTimeout(old);
    this.leaseWindowSec.set(runId, seconds);
    const t = setTimeout(() => {
      this.leaseTimers.delete(runId);
      this.leaseWindowSec.delete(runId);
      // markCompleted releases the worker's slot and clears the
      // run→worker mapping. The settlement listeners (e.g., the
      // run-completion-registry awaiter) get notified separately so a
      // dispatch-or-local awaiter rejects instead of hanging.
      this.markCompleted(runId);
      for (const l of this.listeners) l(runId, { kind: "lease_expired" });
    }, seconds * 1000);
    this.leaseTimers.set(runId, t);
  }

  /**
   * Spec NOTE N2: ANY frame referencing a run_id resets its lease to
   * the original window. Called by the connect handler on RunLog,
   * RunUsage, RunSession, RunLeaseRenew, etc. — independent of run
   * output volume so a long quiet compile does not lose its lease.
   */
  touchLease(runId: string): void {
    if (!this.runToWorker.has(runId)) return;
    const win = this.leaseWindowSec.get(runId);
    if (!win) return;
    this.armLease(runId, win);
  }

  /**
   * Server-initiated grant extension — used for budget-override grants
   * (sends ServerToWorker.LeaseRenew). Distinct from touchLease which
   * is worker-initiated keepalive.
   */
  extendLease(runId: string, newSeconds: number): void {
    if (!this.runToWorker.has(runId)) return;
    this.armLease(runId, newSeconds);
  }

  onSettlement(listener: SettlementListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Public fanout for callers that observe a settlement signal directly
   * — currently the connect-handler when RunComplete or RunFailed lands.
   * Lease-expiry settlement is fired internally by the lease timer.
   */
  notifySettlement(runId: string, reason: SettlementReason): void {
    for (const l of this.listeners) l(runId, reason);
  }

  // Called by the gRPC handler when it receives RunComplete / RunFailed
  // from the worker, OR by the lease arming code on lease expiry.
  // Idempotent — repeated calls for the same runId after the first are
  // no-ops. Cleans up the lease timer too so a markCompleted called
  // because of a normal RunComplete doesn't leave the timer firing
  // a phantom lease_expired settlement.
  markCompleted(runId: string): void {
    const t = this.leaseTimers.get(runId);
    if (t) {
      clearTimeout(t);
      this.leaseTimers.delete(runId);
    }
    this.leaseWindowSec.delete(runId);
    const workerId = this.runToWorker.get(runId);
    if (!workerId) return;
    this.runToWorker.delete(runId);
    this.registry.releaseSlot(workerId);
    // Clear the persisted lease so the reaper doesn't pick this row up.
    // Same fire-and-forget contract as the dispatch-side write.
    this.firePersist({ runId, workerId: null, leaseExpiresAt: null });
  }

  workerForRun(runId: string): string | undefined {
    return this.runToWorker.get(runId);
  }
}

// Process-wide singleton. Tests instantiate fresh instances against
// fresh WorkerRegistry instances to keep state isolated per case.
import { workerRegistry } from "./worker-registry.js";
export const runDispatcher = new RunDispatcher(workerRegistry);
