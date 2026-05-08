import type { ServerToWorker } from "@paperclipai/worker-rpc";

// In-memory registry of currently-connected workers and their state.
// One instance lives on the control plane; workers register on Hello and
// unregister on stream close. The registry is *not* a persistence layer —
// the heartbeat_runs lease columns added in Task 2 are the source of truth
// for which run is on which worker. The registry caches connection-level
// state for the dispatcher's pickFor() decision.
//
// Concurrency model: single-threaded per Node process; the only mutation
// points are gRPC stream callbacks. No locking required as long as no
// async boundary lives inside a register/pickFor/reserveSlot triple.

export interface RegisteredWorker {
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  inFlight: number;
  draining: boolean;
  // Send pushes a frame onto the worker's outbound bidi stream. The handler
  // wires this to the underlying gRPC call writer (Task 5).
  send: (msg: ServerToWorker) => Promise<void>;
  // disconnect closes the worker's stream. Used by N1's evict-on-duplicate
  // logic and by the Drain flow's terminal step.
  disconnect: () => void;
}

export class WorkerRegistry {
  private workers = new Map<string, RegisteredWorker>();

  register(w: RegisteredWorker): void {
    this.workers.set(w.workerId, w);
  }

  unregister(workerId: string): void {
    this.workers.delete(workerId);
  }

  list(): RegisteredWorker[] {
    return [...this.workers.values()];
  }

  get(workerId: string): RegisteredWorker | undefined {
    return this.workers.get(workerId);
  }

  // Pick the least-loaded healthy worker that supports `adapterType`.
  // Excludes draining workers (spec D3 — drained workers stay registered
  // until in-flight runs complete but receive no new dispatches).
  // Returns null when no eligible worker exists; the caller queues at the
  // dispatcher level until a slot opens or a new instance comes online
  // (spec failure-modes table, "Worker out of capacity").
  pickFor(adapterType: string): RegisteredWorker | null {
    let best: RegisteredWorker | null = null;
    for (const w of this.workers.values()) {
      if (w.draining) continue;
      if (!w.adapters.includes(adapterType)) continue;
      if (w.inFlight >= w.maxConcurrent) continue;
      if (best === null || w.inFlight < best.inFlight) best = w;
    }
    return best;
  }

  markDraining(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.draining = true;
  }

  reserveSlot(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`unknown worker ${workerId}`);
    w.inFlight += 1;
  }

  releaseSlot(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.inFlight = Math.max(0, w.inFlight - 1);
  }
}

// Process-wide singleton consumed by the gRPC handler (Task 5) and the
// run-dispatcher (Task 8). Exporting the class separately lets tests
// instantiate fresh registries without sharing state.
export const workerRegistry = new WorkerRegistry();
