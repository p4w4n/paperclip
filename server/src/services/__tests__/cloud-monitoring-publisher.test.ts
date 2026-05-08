// Plan 5: opt-in Cloud Monitoring publisher. Tests use a fake
// MetricServiceClient so neither network nor @google-cloud/monitoring
// is required. Real client is lazy-imported in production at the
// publishMetrics entry point — keeps unit tests fast and avoids the
// load cost when the feature is off.

import { describe, it, expect, vi } from "vitest";
import { publishWorkerMetrics, type MetricServiceClientLike } from "../cloud-monitoring-publisher.js";

describe("publishWorkerMetrics", () => {
  it("writes a TimeSeries point per metric to the configured project", async () => {
    const calls: Array<{ name: string; metricType: string; value: number }> = [];
    const client: MetricServiceClientLike = {
      async createTimeSeries(req) {
        for (const ts of req.timeSeries) {
          calls.push({
            name: req.name,
            metricType: ts.metric.type,
            value: ts.points[0].value.int64Value,
          });
        }
        return [{}];
      },
    };
    await publishWorkerMetrics({
      projectId: "test-proj",
      client,
      metrics: {
        queueDepth: 3,
        inflightRuns: 1,
        availableCapacity: 2,
        totalCapacity: 4,
        drainingWorkers: 0,
      },
    });
    expect(calls.map((c) => c.metricType).sort()).toEqual([
      "custom.googleapis.com/paperclip/available_capacity",
      "custom.googleapis.com/paperclip/draining_workers",
      "custom.googleapis.com/paperclip/inflight_runs",
      "custom.googleapis.com/paperclip/queue_depth",
      "custom.googleapis.com/paperclip/total_capacity",
    ]);
    expect(calls.every((c) => c.name === "projects/test-proj")).toBe(true);
    const queueDepth = calls.find((c) => c.metricType.endsWith("queue_depth"));
    expect(queueDepth?.value).toBe(3);
  });

  it("absorbs client errors so a publish failure doesn't crash the interval", async () => {
    const client: MetricServiceClientLike = {
      async createTimeSeries() {
        throw new Error("monitoring API unavailable");
      },
    };
    await expect(
      publishWorkerMetrics({
        projectId: "test-proj",
        client,
        metrics: {
          queueDepth: 0,
          inflightRuns: 0,
          availableCapacity: 0,
          totalCapacity: 0,
          drainingWorkers: 0,
        },
        onError: () => {
          /* swallowed */
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates client error when no onError is supplied", async () => {
    const client: MetricServiceClientLike = {
      async createTimeSeries() {
        throw new Error("boom");
      },
    };
    await expect(
      publishWorkerMetrics({
        projectId: "test-proj",
        client,
        metrics: {
          queueDepth: 0,
          inflightRuns: 0,
          availableCapacity: 0,
          totalCapacity: 0,
          drainingWorkers: 0,
        },
      }),
    ).rejects.toThrow(/boom/);
  });
});
