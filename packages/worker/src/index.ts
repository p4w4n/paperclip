// paperclip-worker entrypoint. Reads configuration from env, opens the
// connect loop to the control plane, and holds the process open so the
// bidi stream stays alive.
//
// Reconnect / exponential backoff on disconnect is queued as a follow-up
// once Task 8's run dispatcher gives us state to reconcile across
// connection cycles. For v1 of this scaffold a stream drop kills the
// process; the MIG instance autohealing brings it back up.

import { staticBearerAuth } from "./auth-client.js";
import { startWorkerClient, type WorkerClientHandle } from "./client.js";
import { handleRunDispatch } from "./run-handler.js";
import { realizeWorkspace } from "./workspace.js";
import { runAdapterOnWorker } from "./heartbeat-runner-shim.js";
import { randomUUID } from "node:crypto";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const addr = required("PAPERCLIP_CONTROL_PLANE_ADDR");
  const secret = required("PAPERCLIP_WORKER_SHARED_SECRET");
  const adapters = (process.env.PAPERCLIP_WORKER_ADAPTERS ?? "claude_local,gemini_local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxConcurrent = Math.max(1, parseInt(process.env.PAPERCLIP_WORKER_MAX_CONCURRENT ?? "1", 10) || 1);

  // Hold the client handle in an outer scope so onDispatch can call
  // client.send to emit RunUsage / RunComplete / RunFailed back on the
  // same stream the dispatch arrived on.
  let client: WorkerClientHandle;
  client = await startWorkerClient({
    controlPlaneAddress: addr,
    auth: staticBearerAuth(secret),
    // PAPERCLIP_WORKER_ID — set explicitly when running on a GCE MIG so
    // it's durable across worker process restarts within the same
    // instance (spec NOTE N1). Random fallback only for local dev.
    workerId: process.env.PAPERCLIP_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    instanceId: process.env.GCE_INSTANCE_ID ?? "local",
    zone: process.env.GCE_ZONE,
    image: process.env.GCE_IMAGE,
    adapters,
    maxConcurrent,
    version: "0.0.0",
    onDispatch: (msg) => {
      if (msg.payload.case !== "runDispatch") return;
      const dispatch = msg.payload.value;
      // Run handler is fire-and-forget from the bidi stream's
      // perspective — the handler emits RunComplete / RunFailed on the
      // outbound side when done. Errors inside the handler turn into
      // RunFailed frames; they should never escape unhandled.
      void handleRunDispatch(dispatch, {
        realizeWorkspace: (desc) => realizeWorkspace(desc),
        runAdapter: (ctx) => runAdapterOnWorker(dispatch.adapterType, ctx),
        // fetchSecrets stub for v1. Task 11 wires the real
        // FetchSecrets unary RPC against the control plane — the
        // adapter receives an empty env until then, which means
        // adapters that need real credentials fail with a clear
        // missing-secret error rather than running with bogus values.
        fetchSecrets: async () => ({}),
        send: (m) => client.send(m),
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[worker] unexpected handler error for run", dispatch.runId, err);
      });
    },
  });

  // Hold the process open. The connect loop runs callback-driven inside
  // the gRPC client; nothing else needs the event loop alive here.
  await new Promise(() => {});
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
