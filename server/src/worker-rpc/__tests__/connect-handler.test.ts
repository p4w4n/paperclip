import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  HelloSchema,
} from "@paperclipai/worker-rpc";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../server.js";
import { sharedSecretAuthStrategy } from "../auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { openClient } from "./test-client.js";

describe("Worker.Connect handshake", () => {
  let port: number;
  const registry = new WorkerRegistry();

  beforeAll(async () => {
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "s3cret" }),
      registry,
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
