// Plan 5 admin operational surface. Read-only over the in-memory
// WorkerRegistry plus a manual Drain trigger (POST :id/drain — added
// in P5-2). Instance-admin only; the registry is process-level state
// that ordinary org members shouldn't see.

import { Router, type Request, type Response } from "express";
import type { WorkerRegistry, RegisteredWorker } from "../services/worker-registry.js";
import { assertInstanceAdmin } from "./authz.js";

interface WorkersRoutesOpts {
  registry: WorkerRegistry;
}

interface WorkerSnapshot {
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  inFlight: number;
  draining: boolean;
}

interface WorkersSummary {
  totalConnected: number;
  totalCapacity: number;
  inflightRuns: number;
  draining: number;
}

function snapshotWorker(w: RegisteredWorker): WorkerSnapshot {
  return {
    workerId: w.workerId,
    instanceId: w.instanceId,
    adapters: w.adapters,
    maxConcurrent: w.maxConcurrent,
    inFlight: w.inFlight,
    draining: w.draining,
  };
}

function summarize(workers: WorkerSnapshot[]): WorkersSummary {
  return {
    totalConnected: workers.length,
    totalCapacity: workers.reduce((acc, w) => acc + w.maxConcurrent, 0),
    inflightRuns: workers.reduce((acc, w) => acc + w.inFlight, 0),
    draining: workers.filter((w) => w.draining).length,
  };
}

export function workersRoutes(opts: WorkersRoutesOpts): Router {
  const router = Router();

  router.get("/_workers", (req: Request, res: Response) => {
    assertInstanceAdmin(req);
    const workers = opts.registry.list().map(snapshotWorker);
    res.json({
      workers,
      summary: summarize(workers),
    });
  });

  return router;
}
