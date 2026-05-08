import { describe, it, expect } from "vitest";
import { workerSessions } from "../worker_sessions.js";
import { heartbeatRuns } from "../heartbeat_runs.js";

describe("worker_sessions schema", () => {
  it("has the required columns", () => {
    const cols = Object.keys(workerSessions);
    for (const k of [
      "id",
      "workerId",
      "instanceId",
      "zone",
      "image",
      "adapters",
      "maxConcurrent",
      "connectedAt",
      "lastSeenAt",
      "version",
    ]) {
      expect(cols).toContain(k);
    }
  });
});

describe("heartbeat_runs lease columns", () => {
  it("declares lease columns", () => {
    const cols = Object.keys(heartbeatRuns);
    for (const k of ["leaseExpiresAt", "attempts", "dispatchedToWorkerId", "workerSessionId"]) {
      expect(cols).toContain(k);
    }
  });
});
