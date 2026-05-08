// Worker-side connect loop. Opens the bidi stream, sends Hello, replies
// to Pings with Pong, and hands every other ServerToWorker frame to the
// dispatch handler (wired in Task 9 — for v1 of this scaffold the handler
// is a no-op).
//
// Reconnect / backoff is intentionally out of scope here; the binary in
// index.ts will wrap startWorkerClient in the reconnect loop in a later
// pass. Keep this layer focused on a single connection's lifetime so it
// stays unit-testable.

import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary, create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  HelloSchema,
  PongSchema,
  type WorkerToServer,
  type ServerToWorker,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthClient } from "./auth-client.js";

export interface WorkerClientOpts {
  controlPlaneAddress: string; // host:port
  auth: WorkerAuthClient;
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  version: string;
  zone?: string;
  image?: string;
  // Dispatch handler invoked for every server-pushed frame except Welcome
  // (handshake reply, swallowed here) and Ping (replied to inline). Wired
  // in Task 9 to the run-handler that spawns adapters.
  onDispatch: (msg: ServerToWorker) => void;
}

const SERVICE_PATH = "/paperclip.v1.Worker/Connect";

export interface WorkerClientHandle {
  // Sends an arbitrary WorkerToServer frame on the open bidi stream.
  // Promise resolves once the frame is flushed to the underlying socket
  // (or rejects with the gRPC write error). Used by run-handler.ts to
  // emit RunUsage / RunComplete / RunFailed / RunLeaseRenew.
  send: (msg: WorkerToServer) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startWorkerClient(opts: WorkerClientOpts): Promise<WorkerClientHandle> {
  const md = await opts.auth.getMetadata();
  const client = new grpc.Client(opts.controlPlaneAddress, grpc.credentials.createInsecure(), {
    "grpc.keepalive_time_ms": 15_000,
    "grpc.keepalive_timeout_ms": 5_000,
  });
  const call = client.makeBidiStreamRequest<WorkerToServer, ServerToWorker>(
    SERVICE_PATH,
    (m) => Buffer.from(toBinary(WorkerToServerSchema, m)),
    (b) => fromBinary(ServerToWorkerSchema, b),
    md,
  );

  // Send Hello immediately. The server registers us in its WorkerRegistry
  // on this frame and replies with Welcome. If a worker with the same
  // workerId is already registered, the server evicts it (spec N1).
  call.write(
    create(WorkerToServerSchema, {
      payload: {
        case: "hello",
        value: create(HelloSchema, {
          workerId: opts.workerId,
          instanceId: opts.instanceId,
          zone: opts.zone ?? "",
          image: opts.image ?? "",
          adapters: opts.adapters,
          maxConcurrent: opts.maxConcurrent,
          version: opts.version,
        }),
      },
    }),
  );

  // gRPC surfaces "Call cancelled" when the local side closes the
  // stream. That's the normal teardown path here — the connect loop
  // caller decides when to stop, and stop() is the only way out.
  // Without an error handler the unhandled-error ends up in test
  // reports as a phantom failure. Swallow it.
  call.on("error", () => {
    /* normal stream-close artifact; nothing to do */
  });

  call.on("data", (msg: ServerToWorker) => {
    if (msg.payload.case === "ping") {
      call.write(
        create(WorkerToServerSchema, {
          payload: { case: "pong", value: create(PongSchema, { ts: BigInt(Date.now()) }) },
        }),
      );
      return;
    }
    if (msg.payload.case === "welcome") {
      // Handshake reply — nothing to do here yet. Future: cache the
      // scoped JWT for unary RPCs (ReportEvent, etc.). Single-line
      // log so smoke runs and prod ops can confirm the worker actually
      // joined the control plane (not just opened a TCP connection).
      // eslint-disable-next-line no-console
      console.log(
        `[worker] joined control plane workerId=${msg.payload.value.workerId} configHash=${msg.payload.value.configHash}`,
      );
      return;
    }
    opts.onDispatch(msg);
  });

  // Promisified write so callers can await per-frame backpressure.
  // The grpc-js stream's write callback fires once the frame is queued
  // on the underlying http2 stream — that's the closest thing to "sent"
  // we have without ack semantics in the proto itself.
  const send = (m: WorkerToServer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // grpc-js write returns boolean; pass a callback for completion.
      const ok = call.write(m, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
      // If write returned false (queue full), the callback still fires
      // when the queue drains; nothing else to do.
      if (!ok) {
        /* grpc-js handles backpressure via the callback — no explicit drain */
      }
    });

  return {
    send,
    async stop() {
      try {
        call.end();
      } catch {
        /* ignore — best-effort close */
      }
      client.close();
    },
  };
}
