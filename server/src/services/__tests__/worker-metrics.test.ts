// Plan 5: process-internal accounting that the Cloud Monitoring
// publisher reads each tick. Spec D3 — draining workers are excluded
// from availableCapacity so the autoscaler doesn't see "I have N
// workers" while M of them are draining.
//
// Pure function over a snapshot of registered workers; no DB, no
// timers. Tests pass shapes directly.

import { describe, it, expect } from "vitest";
import { computeWorkerMetrics, type WorkerSnapshot } from "../worker-metrics.js";

function w(input: Partial<WorkerSnapshot>): WorkerSnapshot {
  return {
    workerId: input.workerId ?? "w",
    maxConcurrent: input.maxConcurrent ?? 1,
    inFlight: input.inFlight ?? 0,
    draining: input.draining ?? false,
  };
}

describe("computeWorkerMetrics", () => {
  it("empty fleet → zeros", () => {
    expect(computeWorkerMetrics({ workers: [], queueDepth: 0 })).toEqual({
      queueDepth: 0,
      inflightRuns: 0,
      availableCapacity: 0,
      totalCapacity: 0,
      drainingWorkers: 0,
    });
  });

  it("excludes draining workers from availableCapacity (spec D3)", () => {
    const result = computeWorkerMetrics({
      workers: [
        w({ workerId: "a", maxConcurrent: 2, inFlight: 1 }),
        w({ workerId: "b", maxConcurrent: 2, inFlight: 0 }),
        w({ workerId: "c-drain", maxConcurrent: 2, inFlight: 1, draining: true }),
      ],
      queueDepth: 3,
    });
    // a contributes 1, b contributes 2, c excluded → 3
    expect(result.availableCapacity).toBe(3);
    // totalCapacity counts every worker regardless of drain state
    expect(result.totalCapacity).toBe(6);
    expect(result.inflightRuns).toBe(2);
    expect(result.drainingWorkers).toBe(1);
    expect(result.queueDepth).toBe(3);
  });

  it("never goes negative when inFlight somehow exceeds maxConcurrent", () => {
    const result = computeWorkerMetrics({
      workers: [w({ workerId: "a", maxConcurrent: 1, inFlight: 5 })],
      queueDepth: 0,
    });
    expect(result.availableCapacity).toBe(0);
  });
});
