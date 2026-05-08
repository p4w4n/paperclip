// gRPC server bootstrap for the Worker service. Exposes:
//
//   - Worker.Connect (bidi stream) — long-lived dispatch / log / lease channel
//   - Worker.FetchSecrets (unary) — per-run scoped secrets
//
// Wiring lives here; per-RPC behaviour lives in connect-handler.ts and
// secrets-handler.ts so they can be unit-tested without spinning up gRPC.
//
// startWorkerGrpcServer returns the bound port (useful for tests using
// "127.0.0.1:0" to grab an OS-assigned port). stopWorkerGrpcServer is a
// graceful shutdown — call it in the same SIGINT/SIGTERM hook that flushes
// OTel traces. tryShutdown drains in-flight RPCs, so workers mid-stream
// get to finish their current frame before we close.

import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  ServerToWorkerSchema,
  type WorkerToServer,
  type ServerToWorker,
  FetchSecretsRequestSchema,
  FetchSecretsResponseSchema,
  type FetchSecretsRequest,
  type FetchSecretsResponse,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry } from "../services/worker-registry.js";
import type { RunDispatcher } from "../services/run-dispatcher.js";
import { handleConnect } from "./connect-handler.js";
import { handleFetchSecrets } from "./secrets-handler.js";
import { scopeTokenStore } from "./scope-token-store.js";

const SERVICE = "paperclip.v1.Worker";

export interface StartGrpcServerOpts {
  auth: WorkerAuthStrategy;
  registry: WorkerRegistry;
  // Dispatcher used by handleConnect to touchLease on inbound run frames
  // and notify settlement on RunComplete/RunFailed. Threaded through
  // explicitly (rather than imported as the singleton) so tests can
  // pass their own dispatcher backed by the same registry.
  dispatcher: RunDispatcher;
  // Plan 2 Task 4 — late-frame drop gate. See connect-handler's
  // HandleConnectOpts for the contract; production wires a Drizzle
  // select on heartbeat_runs.dispatched_to_worker_id.
  getCurrentDispatchedWorker?: (runId: string) => Promise<string | null>;
  bindAddress: string; // e.g. "0.0.0.0:50051" or "127.0.0.1:0" (test)
}

let server: grpc.Server | null = null;

export async function startWorkerGrpcServer(opts: StartGrpcServerOpts): Promise<number> {
  // Keepalive options match the spec: gRPC-level pings every 15s, declare
  // dead at 60s without a frame. Worker-level Ping frames in
  // connect-handler.ts run on the application stream above this.
  server = new grpc.Server({
    "grpc.keepalive_time_ms": 15_000,
    "grpc.keepalive_timeout_ms": 5_000,
    "grpc.keepalive_permit_without_calls": 1,
  });

  server.addService(
    {
      Connect: {
        path: `/${SERVICE}/Connect`,
        requestStream: true,
        responseStream: true,
        requestSerialize: (m: WorkerToServer) => Buffer.from(toBinary(WorkerToServerSchema, m)),
        requestDeserialize: (b: Buffer) => fromBinary(WorkerToServerSchema, b),
        responseSerialize: (m: ServerToWorker) => Buffer.from(toBinary(ServerToWorkerSchema, m)),
        responseDeserialize: (b: Buffer) => fromBinary(ServerToWorkerSchema, b),
        originalName: "Connect",
      },
      FetchSecrets: {
        path: `/${SERVICE}/FetchSecrets`,
        requestStream: false,
        responseStream: false,
        requestSerialize: (m: FetchSecretsRequest) => Buffer.from(toBinary(FetchSecretsRequestSchema, m)),
        requestDeserialize: (b: Buffer) => fromBinary(FetchSecretsRequestSchema, b),
        responseSerialize: (m: FetchSecretsResponse) => Buffer.from(toBinary(FetchSecretsResponseSchema, m)),
        responseDeserialize: (b: Buffer) => fromBinary(FetchSecretsResponseSchema, b),
        originalName: "FetchSecrets",
      },
    } as unknown as grpc.ServiceDefinition,
    {
      Connect: (call: grpc.ServerDuplexStream<WorkerToServer, ServerToWorker>) => {
        handleConnect(call, opts).catch((err) => {
          call.destroy(err instanceof Error ? err : new Error(String(err)));
        });
      },
      FetchSecrets: (
        call: grpc.ServerUnaryCall<FetchSecretsRequest, FetchSecretsResponse>,
        cb: grpc.sendUnaryData<FetchSecretsResponse>,
      ) => {
        // Wire the production scope-token store as the lookup
        // dependency. Spec D2: token alone authenticates; no secondary
        // auth header check on this RPC.
        handleFetchSecrets(call.request, {
          lookupAndInvalidate: (token) => scopeTokenStore.lookupAndInvalidate(token),
        }).then(
          (resp) => cb(null, resp),
          (err) => cb(err as grpc.ServiceError),
        );
      },
    } as grpc.UntypedServiceImplementation,
  );

  return new Promise<number>((resolve, reject) => {
    server!.bindAsync(opts.bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      resolve(port);
    });
  });
}

export async function stopWorkerGrpcServer(opts?: { forceAfterMs?: number }): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  // Race graceful shutdown against a force-close fallback. tryShutdown
  // waits for every in-flight RPC to terminate naturally — for our bidi
  // streams that means the worker has to close its side first. In tests
  // and during emergency shutdown that wait can stretch indefinitely.
  // After `forceAfterMs` (default 3s) we forceShutdown so the process
  // exit path doesn't hang.
  const forceAfter = opts?.forceAfterMs ?? 3_000;
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        s.forceShutdown();
      } catch {
        /* ignore */
      }
      finish();
    }, forceAfter);
    s.tryShutdown(() => {
      clearTimeout(timer);
      finish();
    });
  });
}
