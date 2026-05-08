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

export class RunDispatcher {
  // runId → workerId. Source of truth for "which worker did I send this
  // run to?" so markCompleted / markFailed know which slot to release.
  // The DB's heartbeat_runs.dispatched_to_worker_id is the persistent
  // companion (Task 10); this map covers in-process state for the
  // duration of the dispatch lifecycle.
  private runToWorker = new Map<string, string>();

  constructor(private readonly registry: WorkerRegistry) {}

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

    return { dispatched: true, workerId: worker.workerId };
  }

  // Called by the gRPC handler when it receives RunComplete / RunFailed
  // from the worker, OR by the lease reaper when the lease expires
  // without resolution. Idempotent — repeated calls for the same runId
  // after the first are no-ops.
  markCompleted(runId: string): void {
    const workerId = this.runToWorker.get(runId);
    if (!workerId) return;
    this.runToWorker.delete(runId);
    this.registry.releaseSlot(workerId);
  }

  workerForRun(runId: string): string | undefined {
    return this.runToWorker.get(runId);
  }
}

// Process-wide singleton. Tests instantiate fresh instances against
// fresh WorkerRegistry instances to keep state isolated per case.
import { workerRegistry } from "./worker-registry.js";
export const runDispatcher = new RunDispatcher(workerRegistry);
