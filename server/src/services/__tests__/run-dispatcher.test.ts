import { describe, it, expect, beforeEach } from "vitest";
import type { ServerToWorker } from "@paperclipai/worker-rpc";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";
import { RunDispatcher } from "../run-dispatcher.js";

interface FakeWorker extends RegisteredWorker {
  sent: ServerToWorker[];
}

function fakeWorker(adapters: string[]): FakeWorker {
  const sent: ServerToWorker[] = [];
  return {
    workerId: "w-1",
    instanceId: "i-1",
    adapters,
    maxConcurrent: 1,
    inFlight: 0,
    draining: false,
    sent,
    send: async (m) => {
      sent.push(m);
    },
    disconnect: () => {},
  };
}

describe("RunDispatcher", () => {
  let registry: WorkerRegistry;
  let dispatcher: RunDispatcher;
  beforeEach(() => {
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
  });

  it("returns null intent receipt when no worker available", async () => {
    const r = await dispatcher.tryDispatch({
      runId: "r-1",
      agentId: "a-1",
      adapterType: "pi_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(r.dispatched).toBe(false);
  });

  it("sends a RunDispatch frame to a capable worker", async () => {
    const w = fakeWorker(["pi_local"]);
    registry.register(w);
    const r = await dispatcher.tryDispatch({
      runId: "r-2",
      agentId: "a-2",
      adapterType: "pi_local",
      adapterConfig: { foo: 1 },
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(r.dispatched).toBe(true);
    expect(w.sent.length).toBe(1);
    expect(w.sent[0].payload.case).toBe("runDispatch");
    expect(w.inFlight).toBe(1);
  });

  it("completeRun releases the slot", async () => {
    const w = fakeWorker(["pi_local"]);
    registry.register(w);
    await dispatcher.tryDispatch({
      runId: "r-3",
      agentId: "a-3",
      adapterType: "pi_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 300,
    });
    expect(w.inFlight).toBe(1);
    dispatcher.markCompleted("r-3");
    expect(w.inFlight).toBe(0);
  });
});
