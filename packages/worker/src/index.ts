// paperclip-worker entrypoint. Reads configuration from env, opens the
// connect loop to the control plane, and holds the process open via
// the reconnect supervisor so a stream drop transparently re-Hellos.

import { staticBearerAuth, gcpIdTokenAuth, type WorkerAuthClient } from "./auth-client.js";
import { startWorkerClient, type WorkerClientHandle } from "./client.js";
import { handleRunDispatch } from "./run-handler.js";
import { realizeWorkspace } from "./workspace.js";
import { runAdapterOnWorker } from "./heartbeat-runner-shim.js";
import { fetchSecretsFromControlPlane } from "./secret-fetcher.js";
import { connectWithBackoff } from "./reconnect.js";
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
  const adapters = (process.env.PAPERCLIP_WORKER_ADAPTERS ?? "claude_local,gemini_local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxConcurrent = Math.max(1, parseInt(process.env.PAPERCLIP_WORKER_MAX_CONCURRENT ?? "1", 10) || 1);

  // Auth strategy mirrors the server's. shared_secret is the default so
  // existing local docker-compose setups don't need a config change;
  // gcp_id_token mode is what the production MIG rolls out with.
  const authMode = process.env.PAPERCLIP_WORKER_AUTH_MODE ?? "shared_secret";
  let auth: WorkerAuthClient;
  if (authMode === "shared_secret") {
    auth = staticBearerAuth(required("PAPERCLIP_WORKER_SHARED_SECRET"));
  } else if (authMode === "gcp_id_token") {
    auth = gcpIdTokenAuth({ audience: required("PAPERCLIP_WORKER_AUDIENCE") });
  } else {
    // eslint-disable-next-line no-console
    console.error(`unknown PAPERCLIP_WORKER_AUTH_MODE: ${authMode}`);
    process.exit(2);
  }

  const workerId = process.env.PAPERCLIP_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;

  // Reconnect supervisor: stream EOF / transport error → back off → re-
  // Hello with the same workerId (spec NOTE N1: server evicts the prior
  // session on duplicate Hello). SIGTERM aborts the loop so a graceful
  // shutdown actually exits the process.
  const ctrl = new AbortController();
  const onSigterm = () => ctrl.abort();
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigterm);

  // The active client handle is captured in a closure so the dispatch
  // callback always sends on the *current* stream; reconnects swap it
  // out on the way through.
  let client: WorkerClientHandle | null = null;

  await connectWithBackoff({
    maxBackoffMs: 30_000,
    signal: ctrl.signal,
    sleep: (ms) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        if (typeof t.unref === "function") t.unref();
      }),
    start: async () => {
      const fresh = await startWorkerClient({
        controlPlaneAddress: addr,
        auth,
        // PAPERCLIP_WORKER_ID is durable across worker process restarts
        // within the same GCE instance (spec NOTE N1). Random fallback
        // only for local dev.
        workerId,
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
          // perspective — emits RunComplete / RunFailed on the outbound
          // side when done. Errors inside the handler turn into
          // RunFailed frames; they should never escape unhandled.
          void handleRunDispatch(dispatch, {
            realizeWorkspace: (desc) => realizeWorkspace(desc),
            runAdapter: (ctx) => runAdapterOnWorker(dispatch.adapterType, ctx),
            // Real FetchSecrets unary RPC against the control plane.
            // Spec D2: scope_token alone authenticates; the server's
            // scope-token store atomically invalidates on first lookup
            // so a replay fails.
            fetchSecrets: (token) => fetchSecretsFromControlPlane(addr, token),
            // Closure over the latest client so a reconnect mid-dispatch
            // sends RunComplete on the new stream. Old stream's send
            // would throw, which the handler catches as RunFailed —
            // acceptable because the server's late-frame drop gate
            // (Plan 2 Task 4) ignores stale RunFailed anyway.
            send: (m) => {
              if (!client) throw new Error("worker client not connected");
              return client.send(m);
            },
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[worker] unexpected handler error for run", dispatch.runId, err);
          });
        },
      });
      client = fresh;
      return fresh;
    },
  });

  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigterm);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
