import { describe, it, expect } from "vitest";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../server.js";
import { sharedSecretAuthStrategy } from "../auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";

describe("worker gRPC lifecycle", () => {
  it("starts on a random port, stops cleanly", async () => {
    const registry = new WorkerRegistry();
    const port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "x" }),
      registry,
      dispatcher: new RunDispatcher(registry),
      bindAddress: "127.0.0.1:0",
    });
    expect(port).toBeGreaterThan(0);
    await stopWorkerGrpcServer();
  });
});
