// Plan 5: process-internal accounting that the Cloud Monitoring
// publisher reads on each tick. Pure function — production wraps it
// with workerRegistry.list() + a pending-dispatch counter; tests pass
// snapshots directly.
//
// Spec D3: "queue_depth excludes draining workers from available
// capacity, since they will not accept new dispatches". Otherwise
// the autoscaler reads "I have N workers" while M of them are
// draining and won't take work, and the signal under-provisions.

export interface WorkerSnapshot {
  workerId: string;
  maxConcurrent: number;
  inFlight: number;
  draining: boolean;
}

export interface WorkerMetricsInput {
  workers: WorkerSnapshot[];
  // Pending dispatches that didn't fit on a worker. Tracked by the
  // dispatcher's own counter; tests pass directly.
  queueDepth: number;
}

export interface WorkerMetrics {
  queueDepth: number;
  inflightRuns: number;
  // Spec D3: excludes draining workers.
  availableCapacity: number;
  // Total maxConcurrent across every connected worker, regardless of
  // drain state. Useful for "fleet size" panels separate from
  // available capacity.
  totalCapacity: number;
  drainingWorkers: number;
}

export function computeWorkerMetrics(input: WorkerMetricsInput): WorkerMetrics {
  let inflight = 0;
  let totalCap = 0;
  let availCap = 0;
  let draining = 0;
  for (const w of input.workers) {
    inflight += w.inFlight;
    totalCap += w.maxConcurrent;
    if (w.draining) {
      draining += 1;
      continue;
    }
    availCap += Math.max(0, w.maxConcurrent - w.inFlight);
  }
  return {
    queueDepth: input.queueDepth,
    inflightRuns: inflight,
    availableCapacity: availCap,
    totalCapacity: totalCap,
    drainingWorkers: draining,
  };
}
