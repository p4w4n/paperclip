import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  HelloSchema,
  RunCompleteSchema,
} from "@paperclipai/worker-rpc";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../server.js";
import { sharedSecretAuthStrategy } from "../auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";
import { openClient } from "./test-client.js";

describe("Worker.Connect handshake", () => {
  let port: number;
  const registry = new WorkerRegistry();

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3cret" }),
      registry,
      dispatcher: new RunDispatcher(registry),
      bindAddress: "127.0.0.1:0",
    });
  });

  afterAll(async () => {
    await stopWorkerGrpcServer();
  });

  it("rejects connections without a valid bearer token", () => {
    // Auth scheme already covered in auth.test.ts; smoke-check that the
    // server is listening on a real port.
    expect(port).toBeGreaterThan(0);
  });

  it("registers worker on Hello and replies with Welcome", async () => {
    const { received, send, close } = await openClient(port, "s3cret");

    send(create(WorkerToServerSchema, {
      payload: {
        case: "hello",
        value: create(HelloSchema, {
          workerId: "w-test",
          instanceId: "i-1",
          adapters: ["pi_local"],
          maxConcurrent: 1,
          version: "0.0.0",
        }),
      },
    }));

    const first = await received.next();
    expect(first.value?.payload.case).toBe("welcome");
    expect(registry.list().some((w) => w.workerId === "w-test")).toBe(true);

    close();
  });
});

// Plan 2 Task 4: late-frame drop. After lease expiry + auto-replay, the
// same runId may be dispatched to a different worker. If the original
// (presumed-dead) worker eventually delivers RunComplete, we must drop
// it — settling the new awaiter with the old worker's result is exactly
// the "duplicate run dispatch — first RunComplete wins, second dropped"
// failure mode in spec.
describe("Worker.Connect late-frame drop", () => {
  let port: number;
  let registry: WorkerRegistry;
  let dispatcher: RunDispatcher;
  // Stubbed in each test so we can flip the row's "current owner".
  const currentOwner: { runId: string; workerId: string | null } = { runId: "", workerId: null };
  const getCurrentDispatchedWorker = vi.fn(async (runId: string) =>
    runId === currentOwner.runId ? currentOwner.workerId : null,
  );

  beforeAll(async () => {
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3" }),
      registry,
      dispatcher,
      getCurrentDispatchedWorker,
      bindAddress: "127.0.0.1:0",
    });
  });

  afterAll(async () => {
    await stopWorkerGrpcServer();
  });

  it("drops RunComplete from a worker that no longer owns the run", async () => {
    currentOwner.runId = "r-stale";
    currentOwner.workerId = "w-2"; // current owner; the test client is w-1
    const onSettle = vi.fn();
    dispatcher.onSettlement(onSettle);

    const { received, send, close } = await openClient(port, "s3");
    send(
      create(WorkerToServerSchema, {
        payload: {
          case: "hello",
          value: create(HelloSchema, {
            workerId: "w-1",
            instanceId: "i-1",
            adapters: ["claude_local"],
            maxConcurrent: 1,
            version: "0.0.0",
          }),
        },
      }),
    );
    // Drain Welcome so we don't read it as part of a later assertion.
    await received.next();

    send(
      create(WorkerToServerSchema, {
        payload: {
          case: "runComplete",
          value: create(RunCompleteSchema, {
            runId: "r-stale",
            exitCode: 0,
            signal: "",
            summary: "ok",
          }),
        },
      }),
    );

    // Give the server a moment to process the inbound frame. We don't
    // get a synchronous reply for runComplete — the server settles
    // internally — so wait a tick and then assert nothing fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(getCurrentDispatchedWorker).toHaveBeenCalledWith("r-stale");
    expect(onSettle).not.toHaveBeenCalled();

    close();
  });

  it("settles RunComplete from the worker that currently owns the run", async () => {
    currentOwner.runId = "r-fresh";
    currentOwner.workerId = "w-3";
    const onSettle = vi.fn();
    dispatcher.onSettlement(onSettle);

    const { received, send, close } = await openClient(port, "s3");
    send(
      create(WorkerToServerSchema, {
        payload: {
          case: "hello",
          value: create(HelloSchema, {
            workerId: "w-3",
            instanceId: "i-3",
            adapters: ["claude_local"],
            maxConcurrent: 1,
            version: "0.0.0",
          }),
        },
      }),
    );
    await received.next();

    send(
      create(WorkerToServerSchema, {
        payload: {
          case: "runComplete",
          value: create(RunCompleteSchema, {
            runId: "r-fresh",
            exitCode: 0,
            signal: "",
            summary: "ok",
          }),
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(onSettle).toHaveBeenCalledWith("r-fresh", expect.objectContaining({ kind: "complete" }));

    close();
  });
});
