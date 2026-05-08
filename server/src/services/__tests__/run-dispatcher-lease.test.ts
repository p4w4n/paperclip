import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";
import { RunDispatcher, type PersistLeaseInput } from "../run-dispatcher.js";

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

describe("RunDispatcher lease persistence", () => {
  // The persistLease callback is the bridge between in-process lease state
  // and the heartbeat_runs row that the lease reaper scans after a control-
  // plane restart. We don't write on every touchLease (would be a row
  // update per worker keepalive — every leaseSeconds/3 ≈ 100s); the reaper
  // tolerates a one-cycle drift because it runs every 30s and the lease
  // window defaults to 300s. We DO write on dispatch (start the clock)
  // and on markCompleted (clear the row so the reaper ignores settled runs).
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry();
    // Real timers here: persist callbacks are async and we want their
    // micro-tasks to flush naturally.
    vi.useRealTimers();
  });

  function makeWorker(): RegisteredWorker {
    return {
      workerId: "w-pl",
      instanceId: "i",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      inFlight: 0,
      draining: false,
      send: async () => {},
      disconnect: () => {},
    };
  }

  it("persists lease deadline + dispatched worker on dispatch", async () => {
    registry.register(makeWorker());
    const calls: PersistLeaseInput[] = [];
    const dispatcher = new RunDispatcher(registry, {
      persistLease: async (input) => {
        calls.push(input);
      },
    });
    const before = Date.now();
    await dispatcher.tryDispatch({
      runId: "r-persist",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 60,
    });
    const after = Date.now();
    expect(calls).toHaveLength(1);
    const arg = calls[0];
    expect(arg.runId).toBe("r-persist");
    expect(arg.workerId).toBe("w-pl");
    expect(arg.leaseExpiresAt).toBeInstanceOf(Date);
    // Window is leaseSeconds * 1000 from the dispatch send time. Bracket
    // loosely against the wall-clock window we recorded.
    const expiresMs = (arg.leaseExpiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresMs).toBeLessThanOrEqual(after + 60_000);
  });

  it("clears persisted lease on markCompleted so the reaper ignores it", async () => {
    registry.register(makeWorker());
    const calls: PersistLeaseInput[] = [];
    const dispatcher = new RunDispatcher(registry, {
      persistLease: async (input) => {
        calls.push(input);
      },
    });
    await dispatcher.tryDispatch({
      runId: "r-clear",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 60,
    });
    dispatcher.markCompleted("r-clear");
    // The persistLease in markCompleted is fire-and-forget; let
    // queued microtasks land before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      runId: "r-clear",
      workerId: null,
      leaseExpiresAt: null,
    });
  });

  it("is a no-op when no persistLease is supplied (backward compat)", async () => {
    registry.register(makeWorker());
    // No opts arg — must still work for the existing call sites that
    // don't yet pass persistLease (and for the e2e test).
    const dispatcher = new RunDispatcher(registry);
    const r = await dispatcher.tryDispatch({
      runId: "r-noopt",
      agentId: "a",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 60,
    });
    expect(r.dispatched).toBe(true);
  });
});
