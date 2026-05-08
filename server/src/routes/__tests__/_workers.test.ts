// Plan 5 read-only admin endpoint over the in-memory WorkerRegistry.
// The route is auth-gated via assertInstanceAdmin; tests stub the
// registry directly and skip the auth wiring (covered separately).

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { WorkerRegistry, type RegisteredWorker } from "../../services/worker-registry.js";
import { workersRoutes } from "../_workers.js";

function fakeRegisteredWorker(input: Partial<RegisteredWorker>): RegisteredWorker {
  return {
    workerId: input.workerId ?? "w-1",
    instanceId: input.instanceId ?? "i-1",
    adapters: input.adapters ?? ["claude_local"],
    maxConcurrent: input.maxConcurrent ?? 1,
    inFlight: input.inFlight ?? 0,
    draining: input.draining ?? false,
    send: input.send ?? (async () => {}),
    disconnect: input.disconnect ?? (() => {}),
  };
}

describe("workersRoutes — GET /_workers", () => {
  let app: express.Express;
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry();
    app = express();
    // No auth middleware in the test app — the route's assertInstanceAdmin
    // call is stubbed via the bypass option below. Production wires auth
    // into req.actor before this router; tests inject a synthetic actor.
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).actor = { type: "board", isInstanceAdmin: true };
      next();
    });
    app.use(workersRoutes({ registry }));
  });

  it("returns an empty list when no workers are connected", async () => {
    const res = await request(app).get("/_workers").expect(200);
    expect(res.body.workers).toEqual([]);
    expect(res.body.summary).toEqual({
      totalConnected: 0,
      totalCapacity: 0,
      inflightRuns: 0,
      draining: 0,
    });
  });

  it("returns the registered workers + summary totals", async () => {
    registry.register(fakeRegisteredWorker({ workerId: "w-a", maxConcurrent: 2, inFlight: 1 }));
    registry.register(fakeRegisteredWorker({ workerId: "w-b", maxConcurrent: 1, inFlight: 0 }));
    registry.register(
      fakeRegisteredWorker({ workerId: "w-drain", maxConcurrent: 1, inFlight: 1, draining: true }),
    );

    const res = await request(app).get("/_workers").expect(200);
    expect(res.body.workers).toHaveLength(3);
    const ids = res.body.workers.map((w: { workerId: string }) => w.workerId).sort();
    expect(ids).toEqual(["w-a", "w-b", "w-drain"]);
    expect(res.body.summary).toEqual({
      totalConnected: 3,
      totalCapacity: 4,
      inflightRuns: 2,
      draining: 1,
    });
  });

  it("excludes the send/disconnect closures from the JSON shape", async () => {
    registry.register(fakeRegisteredWorker({ workerId: "w-a" }));
    const res = await request(app).get("/_workers").expect(200);
    const w = res.body.workers[0];
    expect(w.send).toBeUndefined();
    expect(w.disconnect).toBeUndefined();
  });
});
