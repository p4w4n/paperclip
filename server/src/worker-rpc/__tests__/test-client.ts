// Bidi test client for the Worker.Connect RPC. Used only by the integration
// test in connect-handler.test.ts; mirrors the on-the-wire wire format
// without depending on a generated gRPC client (we don't ship one — the
// real worker binary in Task 7 builds its own).
//
// Frames are serialized via @bufbuild/protobuf's toBinary/fromBinary
// against the schemas re-exported from @paperclipai/worker-rpc.

import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  type WorkerToServer,
  type ServerToWorker,
} from "@paperclipai/worker-rpc";

const SERVICE = "paperclip.v1.Worker";

export interface TestClientHandle {
  received: AsyncGenerator<ServerToWorker>;
  send: (m: WorkerToServer) => void;
  close: () => void;
}

export async function openClient(port: number, secret: string): Promise<TestClientHandle> {
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const md = new grpc.Metadata();
  md.set("authorization", `Bearer ${secret}`);
  const call = client.makeBidiStreamRequest(
    `/${SERVICE}/Connect`,
    (m: WorkerToServer) => Buffer.from(toBinary(WorkerToServerSchema, m)),
    (b: Buffer) => fromBinary(ServerToWorkerSchema, b),
    md,
  );

  const queue: ServerToWorker[] = [];
  const waiters: ((m: ServerToWorker | null) => void)[] = [];
  call.on("data", (m: ServerToWorker) => {
    if (waiters.length) waiters.shift()!(m);
    else queue.push(m);
  });
  call.on("end", () => waiters.splice(0).forEach((w) => w(null)));
  call.on("error", () => waiters.splice(0).forEach((w) => w(null)));

  return {
    received: (async function* () {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        const next = await new Promise<ServerToWorker | null>((r) => waiters.push(r));
        if (!next) return;
        yield next;
      }
    })(),
    send: (m: WorkerToServer) => {
      call.write(m);
    },
    close: () => {
      call.end();
      client.close();
    },
  };
}
