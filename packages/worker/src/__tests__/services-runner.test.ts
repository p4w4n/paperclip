// services-runner is the layer above services-supervisor: takes a list
// of RuntimeServiceSpec, starts each via the supervisor, polls
// readiness (port probe / healthcheck / PID-only), and reports status
// transitions back via the injected `send` callback.
//
// Tests use a fake supervisor and fake probes so neither child_process
// nor real network is involved. The runner is a state machine over
// callbacks; that's all we want to pin here.

import { describe, it, expect, vi } from "vitest";
import {
  createServicesRunner,
  type ServicesSupervisorLike,
  type ProbeFn,
} from "../services-runner.js";
import { create } from "@bufbuild/protobuf";
import { RuntimeServiceSpecSchema, type WorkerToServer } from "@paperclipai/worker-rpc";

function makeSupervisor(): ServicesSupervisorLike & { stopped: string[]; started: string[] } {
  const handles = new Map<string, { closed: Promise<void>; exitCode: number | null; signal: NodeJS.Signals | null; pid: number; runId: string; runtimeServiceId: string }>();
  const stopped: string[] = [];
  const started: string[] = [];
  return {
    start(input) {
      started.push(input.runtimeServiceId);
      const handle = {
        closed: new Promise<void>(() => {}),
        exitCode: null,
        signal: null,
        pid: 12345,
        runId: input.runId,
        runtimeServiceId: input.runtimeServiceId,
      };
      handles.set(input.runtimeServiceId, handle);
      return handle;
    },
    async stopAllFor(runId) {
      for (const [id, h] of handles) {
        if (h.runId === runId) {
          stopped.push(id);
          handles.delete(id);
        }
      }
    },
    started,
    stopped,
  };
}

function spec(input: Partial<{ runtimeServiceId: string; serviceName: string; readyPort: number; readyHealthcheckUrl: string; readinessTimeoutSec: number }>) {
  return create(RuntimeServiceSpecSchema, {
    runtimeServiceId: input.runtimeServiceId ?? "s1",
    serviceName: input.serviceName ?? "dev",
    command: "node -e 'setInterval(()=>{},1000)'",
    cwd: "/tmp",
    env: {},
    readyPort: input.readyPort ?? 0,
    readyHealthcheckUrl: input.readyHealthcheckUrl ?? "",
    readinessTimeoutSec: input.readinessTimeoutSec ?? 60,
  });
}

describe("createServicesRunner", () => {
  it("PID-only readiness: emits starting → running once start returns", async () => {
    const sup = makeSupervisor();
    const sent: WorkerToServer[] = [];
    const probe: ProbeFn = async () => true;
    const runner = createServicesRunner({
      supervisor: sup,
      probe,
      send: async (m) => {
        sent.push(m);
      },
    });
    await runner.startAll("r1", [spec({ runtimeServiceId: "s1" })]);
    const states = sent
      .filter((m) => m.payload.case === "serviceStatus")
      .map((m) => m.payload.case === "serviceStatus" ? m.payload.value.state : null);
    expect(states).toEqual(["starting", "running"]);
  });

  it("port-probe success: emits running once probe returns true", async () => {
    const sup = makeSupervisor();
    const sent: WorkerToServer[] = [];
    let attempts = 0;
    const probe: ProbeFn = async () => {
      attempts += 1;
      return attempts >= 3;
    };
    const runner = createServicesRunner({
      supervisor: sup,
      probe,
      send: async (m) => {
        sent.push(m);
      },
      probeIntervalMs: 5,
    });
    await runner.startAll("r1", [spec({ runtimeServiceId: "s1", readyPort: 3000 })]);
    const states = sent
      .filter((m) => m.payload.case === "serviceStatus")
      .map((m) => m.payload.case === "serviceStatus" ? m.payload.value.state : null);
    expect(states).toEqual(["starting", "running"]);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("readiness timeout: rejects, emits failed, stops the started service", async () => {
    const sup = makeSupervisor();
    const sent: WorkerToServer[] = [];
    const probe: ProbeFn = async () => false; // never ready
    const runner = createServicesRunner({
      supervisor: sup,
      probe,
      send: async (m) => {
        sent.push(m);
      },
      probeIntervalMs: 5,
    });
    await expect(
      runner.startAll("r1", [spec({ runtimeServiceId: "s1", readyPort: 3000, readinessTimeoutSec: 1 })]),
    ).rejects.toThrow(/readiness/i);
    const states = sent
      .filter((m) => m.payload.case === "serviceStatus")
      .map((m) => m.payload.case === "serviceStatus" ? m.payload.value.state : null);
    expect(states).toContain("failed");
    expect(sup.stopped).toContain("s1");
  });

  it("rollback: if the second service fails readiness, the first is stopped too", async () => {
    const sup = makeSupervisor();
    const sent: WorkerToServer[] = [];
    let n = 0;
    const probe: ProbeFn = async (svc) => {
      // First service ready immediately; second never ready.
      n += 1;
      return svc.runtimeServiceId === "s1";
    };
    void n; // referenced
    const runner = createServicesRunner({
      supervisor: sup,
      probe,
      send: async (m) => {
        sent.push(m);
      },
      probeIntervalMs: 5,
    });
    await expect(
      runner.startAll("r1", [
        spec({ runtimeServiceId: "s1", readyPort: 3000 }),
        spec({ runtimeServiceId: "s2", readyPort: 3001, readinessTimeoutSec: 1 }),
      ]),
    ).rejects.toThrow();
    expect(sup.stopped.sort()).toEqual(["s1", "s2"]);
  });

  it("stopAllFor delegates to the supervisor", async () => {
    const sup = makeSupervisor();
    const runner = createServicesRunner({
      supervisor: sup,
      probe: async () => true,
      send: async () => {},
    });
    await runner.startAll("r1", [spec({ runtimeServiceId: "s1" })]);
    await runner.stopAllFor("r1");
    expect(sup.stopped).toContain("s1");
  });
});
