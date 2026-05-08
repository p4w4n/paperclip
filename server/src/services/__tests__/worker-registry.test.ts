import { describe, it, expect, beforeEach } from "vitest";
import { WorkerRegistry, type RegisteredWorker } from "../worker-registry.js";

describe("WorkerRegistry", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); });

  function makeWorker(over: Partial<RegisteredWorker> = {}): RegisteredWorker {
    return {
      workerId: "w-1",
      instanceId: "i-1",
      adapters: ["pi_local"],
      maxConcurrent: 1,
      inFlight: 0,
      draining: false,
      send: async () => {},
      disconnect: () => {},
      ...over,
    };
  }

  it("registers and lists workers", () => {
    reg.register(makeWorker());
    expect(reg.list().length).toBe(1);
  });

  it("picks a worker that has capacity for the requested adapter", () => {
    reg.register(makeWorker({ workerId: "w-busy", inFlight: 1, maxConcurrent: 1 }));
    reg.register(makeWorker({ workerId: "w-free", inFlight: 0, maxConcurrent: 1 }));
    const picked = reg.pickFor("pi_local");
    expect(picked?.workerId).toBe("w-free");
  });

  it("returns null when no worker matches the adapter", () => {
    reg.register(makeWorker({ adapters: ["claude_local"] }));
    expect(reg.pickFor("pi_local")).toBeNull();
  });

  it("reserveSlot increments inFlight; releaseSlot decrements", () => {
    const w = makeWorker();
    reg.register(w);
    reg.reserveSlot(w.workerId);
    expect(reg.list()[0].inFlight).toBe(1);
    reg.releaseSlot(w.workerId);
    expect(reg.list()[0].inFlight).toBe(0);
  });

  it("unregister removes the worker", () => {
    const w = makeWorker();
    reg.register(w);
    reg.unregister(w.workerId);
    expect(reg.list().length).toBe(0);
  });
});
