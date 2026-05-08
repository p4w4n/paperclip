// drainAllWorkers is the SIGTERM hook for graceful control-plane
// shutdown. Sends Drain to every connected worker, waits for them to
// disconnect, but caps the wait so a stuck worker doesn't block
// process exit.

import { describe, it, expect, vi } from "vitest";
import { drainAllWorkers, type DrainAllDeps } from "../server-drain.js";

describe("drainAllWorkers", () => {
  it("calls requestDrain for every connected worker", async () => {
    const requestDrain = vi.fn(async () => true);
    const deps: DrainAllDeps = {
      list: () => [
        { workerId: "w-1" },
        { workerId: "w-2" },
        { workerId: "w-3" },
      ],
      requestDrain,
      // Test stub: resolves the moment requestDrain finishes — simulates
      // a "fast drain" where all workers finish their in-flight runs
      // quickly. The real impl awaits stream-end via the registry.
      waitForUnregister: async () => {},
      gracePeriodMs: 100,
    };
    await drainAllWorkers(deps);
    expect(requestDrain).toHaveBeenCalledTimes(3);
    expect(requestDrain).toHaveBeenCalledWith("w-1");
    expect(requestDrain).toHaveBeenCalledWith("w-2");
    expect(requestDrain).toHaveBeenCalledWith("w-3");
  });

  it("returns when waitForUnregister resolves for every worker", async () => {
    let resolved = 0;
    const deps: DrainAllDeps = {
      list: () => [{ workerId: "w-1" }, { workerId: "w-2" }],
      requestDrain: async () => true,
      waitForUnregister: async () => {
        resolved += 1;
      },
      gracePeriodMs: 5_000,
    };
    await drainAllWorkers(deps);
    expect(resolved).toBe(2);
  });

  it("respects gracePeriodMs — stuck workers don't block", async () => {
    const start = Date.now();
    const deps: DrainAllDeps = {
      list: () => [{ workerId: "w-stuck" }],
      requestDrain: async () => true,
      // Never resolves — simulates a worker that won't drain.
      waitForUnregister: () => new Promise(() => {}),
      gracePeriodMs: 50,
    };
    await drainAllWorkers(deps);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("no-op when no workers are connected", async () => {
    const requestDrain = vi.fn(async () => true);
    const deps: DrainAllDeps = {
      list: () => [],
      requestDrain,
      waitForUnregister: async () => {},
      gracePeriodMs: 100,
    };
    await drainAllWorkers(deps);
    expect(requestDrain).not.toHaveBeenCalled();
  });
});
