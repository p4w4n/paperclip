import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";
import { RunDispatcher } from "../run-dispatcher.js";

describe("RunDispatcher lease", () => {
  let registry: WorkerRegistry;
  let dispatcher: RunDispatcher;

  beforeEach(() => {
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
    vi.useFakeTimers();
  });

  function makeWorker(): RegisteredWorker {
    return {
      workerId: "w",
      instanceId: "i",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      inFlight: 0,
      draining: false,
      send: async () => {},
      disconnect: () => {},
    };
  }

  it("settles a run with lease_expired if no completion before deadline", async () => {
    registry.register(makeWorker());
    const settle = vi.fn();
    dispatcher.onSettlement(settle);
    await dispatcher.tryDispatch({
      runId: "r-x",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 1,
    });
    vi.advanceTimersByTime(1500);
    expect(settle).toHaveBeenCalledWith("r-x", expect.objectContaining({ kind: "lease_expired" }));
  });

  it("touchLease before deadline resets it (worker-initiated keepalive)", async () => {
    registry.register(makeWorker());
    const settle = vi.fn();
    dispatcher.onSettlement(settle);
    await dispatcher.tryDispatch({
      runId: "r-y",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 1,
    });
    vi.advanceTimersByTime(800);
    dispatcher.touchLease("r-y");
    vi.advanceTimersByTime(800);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(settle).toHaveBeenCalledWith("r-y", expect.objectContaining({ kind: "lease_expired" }));
  });

  it("markCompleted clears the lease timer", async () => {
    registry.register(makeWorker());
    const settle = vi.fn();
    dispatcher.onSettlement(settle);
    await dispatcher.tryDispatch({
      runId: "r-z",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 1,
    });
    dispatcher.markCompleted("r-z");
    vi.advanceTimersByTime(2000);
    // lease_expired must NOT fire after markCompleted; the run is already done.
    expect(settle).not.toHaveBeenCalledWith("r-z", expect.objectContaining({ kind: "lease_expired" }));
  });
});
