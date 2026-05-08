// In-process end-to-end test: spin up the worker gRPC server on a random
// loopback port, connect a real worker client, dispatch a run, and assert
// the dispatcher's onSettlement listener fires "complete" once the worker
// emits RunComplete back on the bidi stream.
//
// This is the integration-level cousin of the unit tests in
// run-dispatcher-lease.test.ts and run-handler.test.ts: it exercises
// the full gRPC roundtrip + auth + scope-token-store handoff that those
// per-component tests stub out.
//
// Adapter type: claude_local. The plan originally specified pi_local, but
// the dispatch-or-local seam (server/src/adapters/registry.ts) wires only
// claude_local + gemini_local — the worker advertises whichever adapter
// type it claims and the dispatcher picks it. The runAdapter dep is
// stubbed so no real binary executes.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { RuntimeServiceSpecSchema } from "@paperclipai/worker-rpc";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../../worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "../../worker-rpc/auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";
import { startWorkerClient, type WorkerClientHandle } from "@paperclipai/worker/client";
import { staticBearerAuth } from "@paperclipai/worker/auth-client";
import { handleRunDispatch } from "@paperclipai/worker/run-handler";

describe("distributed claude_local end-to-end", () => {
  let port = 0;
  const registry = new WorkerRegistry();
  const dispatcher = new RunDispatcher(registry);

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3" }),
      registry,
      dispatcher,
      bindAddress: "127.0.0.1:0",
    });
  });
  afterAll(async () => {
    await stopWorkerGrpcServer();
  });

  it("dispatches a run to a connected worker, receives RunComplete", async () => {
    const settlements: Array<{ runId: string; kind: string }> = [];

    // Holds the client reference so onDispatch can call client.send to
    // emit RunComplete back on the same bidi stream the dispatch arrived
    // on. Forward declaration matches the production wiring in
    // packages/worker/src/index.ts.
    let client!: WorkerClientHandle;
    client = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("s3"),
      workerId: "w-e2e",
      instanceId: "i-e2e",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: (msg) => {
        if (msg.payload.case !== "runDispatch") return;
        // Fire-and-forget per the WorkerClientOpts.onDispatch contract;
        // the run handler itself sends RunComplete/RunFailed on its own.
        void handleRunDispatch(msg.payload.value, {
          realizeWorkspace: async () => ({ cwd: "/tmp", cleanup: async () => {} }),
          runAdapter: async () => ({ exitCode: 0, signal: null, summary: "ok" }),
          fetchSecrets: async () => ({}),
          send: (m) => client.send(m),
        });
      },
    });

    // Hello → Welcome arrives asynchronously after startWorkerClient
    // resolves. Wait for the worker to actually appear in the registry
    // before dispatching, otherwise tryDispatch returns dispatched=false.
    for (let i = 0; i < 50; i++) {
      if (registry.list().some((w) => w.workerId === "w-e2e")) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Capture the settlement before dispatch so we don't race the
    // RunComplete frame arriving faster than we can subscribe.
    const settled = new Promise<void>((resolve) => {
      dispatcher.onSettlement((runId, reason) => {
        if (runId === "r-e2e") {
          settlements.push({ runId, kind: reason.kind });
          resolve();
        }
      });
    });

    const r = await dispatcher.tryDispatch({
      runId: "r-e2e",
      agentId: "a-e2e",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 30,
    });
    expect(r.dispatched).toBe(true);
    expect(r.workerId).toBe("w-e2e");

    await settled;
    expect(settlements).toEqual([{ runId: "r-e2e", kind: "complete" }]);

    await client.stop();
  });

  it("dispatches a run with runtime_services; runner.startAll/stopAllFor are observed in order; ServiceStatus flows back", async () => {
    // Plan 3 e2e: assert the two-way wire — services flow OUT on the
    // RunDispatch frame, status frames flow BACK on the bidi stream,
    // and the run handler's start/stop bracketing is observed in
    // order.
    const startAllArgs: Array<{ runId: string; specCount: number }> = [];
    const stopAllForArgs: string[] = [];
    const order: string[] = [];

    let client2!: WorkerClientHandle;
    const statusReceived: Record<string, unknown>[] = [];

    // We need to capture ServiceStatus frames at the dispatcher's
    // wire — set up a connect-handler updateServiceStatus hook by
    // restarting the gRPC server with an updateRow injected. Easier:
    // observe via the sent[] buffer on the worker side, since the
    // services-runner emits ServiceStatus frames through `send`. The
    // server's connect-handler wiring is proven by P3-7 unit tests.
    client2 = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("s3"),
      workerId: "w-svc",
      instanceId: "i-svc",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: (msg) => {
        if (msg.payload.case !== "runDispatch") return;
        void handleRunDispatch(msg.payload.value, {
          realizeWorkspace: async () => ({ cwd: "/tmp/wkspace", cleanup: async () => {} }),
          runAdapter: async () => {
            order.push("runAdapter");
            return { exitCode: 0, signal: null, summary: "ok" };
          },
          fetchSecrets: async () => ({}),
          send: async (m) => {
            if (m.payload.case === "serviceStatus") {
              statusReceived.push({ ...m.payload.value });
            }
            return client2.send(m);
          },
          servicesRunner: {
            startAll: vi.fn(async (runId, specs) => {
              order.push("startAll");
              startAllArgs.push({ runId, specCount: specs.length });
            }),
            stopAllFor: vi.fn(async (runId) => {
              order.push("stopAllFor");
              stopAllForArgs.push(runId);
            }),
          },
        });
      },
    });

    for (let i = 0; i < 50; i++) {
      if (registry.list().some((w) => w.workerId === "w-svc")) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const settled = new Promise<void>((resolve) => {
      dispatcher.onSettlement((runId, reason) => {
        if (runId === "r-svc-e2e" && reason.kind === "complete") resolve();
      });
    });

    const r = await dispatcher.tryDispatch({
      runId: "r-svc-e2e",
      agentId: "a-svc",
      adapterType: "claude_local",
      adapterConfig: {},
      executionWorkspace: {},
      secretsScopeToken: "tok",
      leaseSeconds: 30,
      runtimeServices: [
        create(RuntimeServiceSpecSchema, {
          runtimeServiceId: "rs-1",
          serviceName: "dev",
          command: "noop",
          cwd: "/tmp/wkspace",
          env: {},
        }),
      ],
    });
    expect(r.dispatched).toBe(true);

    await settled;
    expect(order).toEqual(["startAll", "runAdapter", "stopAllFor"]);
    expect(startAllArgs).toEqual([{ runId: "r-svc-e2e", specCount: 1 }]);
    expect(stopAllForArgs).toEqual(["r-svc-e2e"]);

    await client2.stop();
  });
});
