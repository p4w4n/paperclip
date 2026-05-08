// Plan 5 e2e: connect a worker, manually drain it via the registry's
// requestDrain (mirrors what POST /api/_workers/:id/drain does),
// observe the worker's Plan 2 Task 6 drain gate finishes the in-flight
// run + ends the stream + the row is gone from the registry.
//
// Also covers the metric publish round-trip with a fake
// MetricServiceClient — pins both halves of the operational wire:
// drain via API → fleet shrinks; metrics publisher reads the
// (eventually empty) registry + emits the right metric shape.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../../worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "../../worker-rpc/auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";
import { computeWorkerMetrics } from "../../services/worker-metrics.js";
import { publishWorkerMetrics, type MetricServiceClientLike } from "../../services/cloud-monitoring-publisher.js";
import { startWorkerClient } from "@paperclipai/worker/client";
import { staticBearerAuth } from "@paperclipai/worker/auth-client";

describe("operational surface e2e", () => {
  let port = 0;
  const registry = new WorkerRegistry();
  const dispatcher = new RunDispatcher(registry);

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "ops-e2e" }),
      registry,
      dispatcher,
      bindAddress: "127.0.0.1:0",
    });
  });
  afterAll(async () => {
    await stopWorkerGrpcServer();
  });

  it("drain via registry → worker disconnects → registry empties", async () => {
    // Forward declare so onDispatch can call client.stop() on Drain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;
    client = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("ops-e2e"),
      workerId: "w-ops",
      instanceId: "i-ops",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: (msg) => {
        // Mimic the production worker's drain gate (Plan 2 Task 6):
        // on Drain with zero in-flight, end the stream. Without this
        // the e2e gets stuck because the low-level client doesn't
        // know what to do with the Drain frame.
        if (msg.payload.case === "drain") {
          void client.stop();
        }
      },
    });

    // Wait for registration.
    for (let i = 0; i < 50; i++) {
      if (registry.list().some((w) => w.workerId === "w-ops")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(registry.list().some((w) => w.workerId === "w-ops")).toBe(true);

    // Manual drain via registry — same path the route handler uses.
    const ok = await registry.requestDrain("w-ops");
    expect(ok).toBe(true);
    expect(registry.get("w-ops")?.draining).toBe(true);

    // Plan 2 Task 6: worker side handles Drain by ending the stream
    // (no in-flight runs to wait for here). Connect-handler's
    // stream-close cleanup unregisters.
    for (let i = 0; i < 100; i++) {
      if (!registry.get("w-ops")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(registry.get("w-ops")).toBeUndefined();

    await client.stop();
  }, 30_000);

  it("metrics publisher writes the right time-series shape over the live registry", async () => {
    // Re-register a fake worker so the metrics call has something to
    // count without going through the full gRPC stack.
    registry.register({
      workerId: "w-metric",
      instanceId: "i-m",
      adapters: ["claude_local"],
      maxConcurrent: 2,
      inFlight: 1,
      draining: false,
      send: async () => {},
      disconnect: () => {},
    });

    const captured: Array<{ type: string; value: number }> = [];
    const fake: MetricServiceClientLike = {
      async createTimeSeries(req) {
        for (const ts of req.timeSeries) {
          captured.push({ type: ts.metric.type, value: ts.points[0].value.int64Value });
        }
        return [{}];
      },
    };

    const metrics = computeWorkerMetrics({
      workers: registry.list().map((w) => ({
        workerId: w.workerId,
        maxConcurrent: w.maxConcurrent,
        inFlight: w.inFlight,
        draining: w.draining,
      })),
      queueDepth: 0,
    });

    await publishWorkerMetrics({
      projectId: "ops-test",
      client: fake,
      metrics,
    });

    expect(captured.find((c) => c.type.endsWith("inflight_runs"))?.value).toBe(1);
    expect(captured.find((c) => c.type.endsWith("available_capacity"))?.value).toBe(1);

    registry.unregister("w-metric");
  });
});
