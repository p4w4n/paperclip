// paperclip-worker entrypoint. Reads configuration from env, opens the
// connect loop to the control plane, and holds the process open so the
// bidi stream stays alive.
//
// Reconnect / exponential backoff on disconnect is queued as a follow-up
// once Task 8's run dispatcher gives us state to reconcile across
// connection cycles. For v1 of this scaffold a stream drop kills the
// process; the MIG instance autohealing brings it back up.

import { staticBearerAuth } from "./auth-client.js";
import { startWorkerClient } from "./client.js";
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
  const adapters = (process.env.PAPERCLIP_WORKER_ADAPTERS ?? "pi_local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxConcurrent = Math.max(1, parseInt(process.env.PAPERCLIP_WORKER_MAX_CONCURRENT ?? "1", 10) || 1);

  await startWorkerClient({
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
    onDispatch: () => {
      // Wired in Task 9.
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
