// Plan 5: opt-in Cloud Monitoring publisher. The MIG autoscaler
// subscribes to `custom.googleapis.com/paperclip/queue_depth` —
// scale up when depth > threshold, scale down when depth = 0 for
// >5min. Other panels (inflight_runs, available_capacity, etc.) are
// emitted alongside for dashboard visibility.
//
// `MetricServiceClientLike` is a minimal interface over what we
// actually call on @google-cloud/monitoring's MetricServiceClient.
// Tests inject a fake; production lazy-imports the real client at
// the boot wire-up so unit tests don't pay the SDK load cost.
//
// Lazy-import precedent: Plan 1 Task 14's gcpIdTokenAuthStrategy
// follows the same pattern with google-auth-library.

import type { WorkerMetrics } from "./worker-metrics.js";

export interface MetricServiceClientLike {
  createTimeSeries(request: {
    name: string;
    timeSeries: Array<{
      metric: { type: string; labels?: Record<string, string> };
      resource: { type: string; labels: Record<string, string> };
      points: Array<{
        interval: { endTime: { seconds: number } };
        value: { int64Value: number };
      }>;
    }>;
  }): Promise<unknown>;
}

export interface PublishWorkerMetricsInput {
  projectId: string;
  client: MetricServiceClientLike;
  metrics: WorkerMetrics;
  // Optional error sink. When set, errors get fed in; when omitted,
  // they propagate so the caller can surface them. Production wires
  // logger.warn so a transient API failure doesn't crash the
  // interval; tests can omit to assert error propagation.
  onError?: (err: Error) => void;
}

export async function publishWorkerMetrics(input: PublishWorkerMetricsInput): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const points = [
    ["queue_depth", input.metrics.queueDepth],
    ["inflight_runs", input.metrics.inflightRuns],
    ["available_capacity", input.metrics.availableCapacity],
    ["total_capacity", input.metrics.totalCapacity],
    ["draining_workers", input.metrics.drainingWorkers],
  ] as const;

  const timeSeries = points.map(([name, value]) => ({
    metric: { type: `custom.googleapis.com/paperclip/${name}` },
    resource: { type: "global", labels: { project_id: input.projectId } },
    points: [
      {
        interval: { endTime: { seconds: nowSec } },
        value: { int64Value: value },
      },
    ],
  }));

  try {
    await input.client.createTimeSeries({
      name: `projects/${input.projectId}`,
      timeSeries,
    });
  } catch (err) {
    if (input.onError) {
      input.onError(err as Error);
      return;
    }
    throw err;
  }
}

// Production factory. Lazy-imports @google-cloud/monitoring so unit
// tests that don't exercise the publisher path don't pay the load
// cost. Returns null when monitoring is disabled or the SDK isn't
// installed — the boot wire-up degrades to a no-op interval in that
// case.
export async function createDefaultMetricClient(): Promise<MetricServiceClientLike | null> {
  try {
    // @google-cloud/monitoring is an opt-in dep — not in package.json
    // by default to keep the OSS install lean. The dynamic import +
    // ts-ignore lets the codepath compile when the package is absent
    // and load successfully when an operator has installed it.
    // @ts-expect-error optional dependency at runtime
    const mod = await import("@google-cloud/monitoring").catch(() => null);
    if (!mod) return null;
    // The real client's createTimeSeries returns [resp, requestObj,
    // responseObj]; our shape only cares about awaiting resolution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Client = (mod as any).MetricServiceClient;
    if (!Client) return null;
    const inst = new Client();
    return {
      async createTimeSeries(req) {
        await inst.createTimeSeries(req);
      },
    };
  } catch {
    return null;
  }
}
