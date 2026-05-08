# Distributed Workers — Design

**Status:** draft, awaiting user review
**Date:** 2026-05-08
**Owner:** pk

## Problem

Today paperclip runs the control plane (`server/`, `ui/`, embedded postgres) and all `*_local` agent processes (claude-code, codex, cursor, gemini, opencode, pi) on the same host. We want to deploy the control plane on one server and let agents execute on a fleet of workers in a separate GCP Managed Instance Group, reachable through the same VPC, so the org-chart can scale horizontally and instance churn doesn't lose state.

## Goals

- Control plane on a single stable host inside a GCP VPC; agents on a horizontally scalable MIG inside the same VPC.
- Any healthy worker can run any agent (pool of generic workers — instances are interchangeable).
- MIG instance churn (autoscaling, health-check replacement, rolling updates) does not lose runs or corrupt state.
- Adapter code (`claude_local`, `codex_local`, …) runs on the worker without modification — only the dispatch boundary changes.
- Existing heartbeat run lifecycle (`queued → running → completed/failed`), run logs, usage capture, and cost tracking continue to work end-to-end.
- Local single-host deployment continues to work for OSS users not on GCP (in-process worker fallback).

## Non-goals (v1)

- Cross-region workers.
- Worker-to-worker direct communication (all routing via control plane).
- Plugin adapters running on the worker — deferred to v1.1; v1 ships built-in adapters only.
- Workers outside the VPC. The protocol allows it conceptually but the auth story is shaped around GCP id-tokens for v1.

## Architecture

```
┌────────────────────────┐         ┌──────────────────────────┐
│ Control plane (one     │         │ MIG: paperclip-workers   │
│ box in same VPC):      │  gRPC   │ N × ephemeral instances  │
│  • server/ + ui/       │◀────────│  • paperclip-worker bin  │
│  • postgres            │ (worker │  • node + claude-code +  │
│  • dispatcher service  │  init.) │    codex + cursor + pi   │
│  • worker registry     │         │  • shallow git, /tmp ws  │
│  • lease reaper        │         │                          │
└────────────────────────┘         └──────────────────────────┘
         │ optional Filestore (NFS) for opt-in heavy-state workspaces
         ▼
   ┌─────────────┐  ┌────────┐
   │  Filestore  │  │  GCS   │  session blobs, artifacts, log overflow
   └─────────────┘  └────────┘
```

### New components

- **`paperclip-worker`** — small Node binary shipped in the MIG VM image. On boot it dials the control plane's gRPC endpoint, authenticates with a GCP id-token, registers capabilities, and waits for run intents on a single bidirectional stream.
- **`worker-registry`** — server-side service tracking connected workers, their adapter capabilities, and in-flight run leases.
- **`run-dispatcher`** — server-side service. When the heartbeat scheduler decides "agent X needs to run," instead of invoking the adapter in-process it asks the dispatcher to pick a worker and stream the run over the worker's gRPC bidi stream.
- **`lease-reaper`** — periodic job. When a worker's stream drops mid-run, the lease expires and the run is re-dispatched (subject to `maxAttempts`).

### Single key seam

Each existing `*_local` adapter on the control plane gains a thin pre-execute branch: **"if a worker is registered that advertises this adapter's capability, dispatch via the worker pool; else fall back to in-process execution."** No new adapter type is exposed to user configuration — the agent's `adapterType` (e.g., `claude_local`) stays as written, and the seam is invisible to user-authored agent configs.

The actual `*_local` adapter code (the part that spawns `claude`, `codex`, `pi`, etc.) runs unchanged on the worker, invoked by the worker's local heartbeat-runner shim. That shim is the same code the server uses today; the only difference is who hosts it.

This preserves the single-host story for OSS users not on GCP: with no workers registered, every adapter executes in-process exactly as it does today.

## Worker ↔ control-plane gRPC contract

New package: `packages/worker-rpc/` containing `.proto` definitions, Buf-driven codegen, and shared TypeScript types.

Single bidirectional RPC: `Worker.Connect(stream WorkerToServer) returns (stream ServerToWorker)`.

### `WorkerToServer` message variants

- `Hello { workerId, instanceId, zone, image, adapters[], maxConcurrent, version }` — first frame after auth handshake.
- `LeaseAck { runId }` / `LeaseNack { runId, reason }` — claim outcome.
- `RunLog { runId, stream, chunk, seq }` — stdout/stderr streamed during run; control plane appends to existing run-log store.
- `RunUsage { runId, usage }` — incremental usage updates.
- `RunSession { runId, codec }` — adapter session blob; control plane persists to GCS or DB.
- `RunComplete { runId, exitCode, signal, summary }` / `RunFailed { runId, error }`.
- `Pong { ts }` — liveness reply.
- `Capacity { inFlight, maxConcurrent }` — explicit capacity update if it changes.

### `ServerToWorker` message variants

- `Welcome { workerId, jwtTtl, configHash }` — handshake reply, includes a 15-min paperclip-scoped JWT for unary RPCs.
- `RunDispatch { runId, agentId, adapterType, adapterConfig, executionWorkspace, secretsScopeToken, sessionRestore?, leaseSeconds }`. `secretsScopeToken` is an opaque server-issued reference, not the secret material; the worker exchanges it via `FetchSecrets(runId)` after dispatch.
- `RunCancel { runId, reason }` — kill switch (budget cap, user cancel, timeout).
- `LeaseRenew { runId, newDeadline }`.
- `Ping { ts }`.
- `Drain` — control plane wants this worker to stop accepting new runs; worker finishes in-flight, sends `Bye`, disconnects. Used during MIG rolling updates.

### Liveness

Server-side gRPC keepalive every 15s; declare worker dead at 60s without a frame. On declared-dead the lease reaper requeues runs that were `running` on that worker.

### Idempotency

`runId` is the canonical key. If a "dead" worker reconnects late and tries to `RunComplete` an already-reassigned run, the second result is logged and dropped (first writer wins).

### Backpressure

Worker advertises `maxConcurrent` (default 1 for code-heavy adapters). Dispatcher tracks each worker's `inFlight` and never exceeds it. Workers at 0 capacity stay registered but receive no dispatches.

### Secondary unary RPCs

- `FetchSecrets(runId) returns SecretBundle` — per-run scoped secrets. Worker presents its 15-min paperclip JWT.
- `ReportEvent(runId, event)` — out-of-band events (e.g., workspace-runtime service lifecycle) when the worker doesn't want to multiplex on the bidi stream.

## Workspace lifecycle on the worker

For each `RunDispatch`:

1. Acquire a local workspace dir under `/var/lib/paperclip/runs/<runId>`.
2. Realize workspace based on `executionWorkspace.mode`:
   - **`ephemeral`** (default):
     - Shallow clone, or fetch from cached bare repo at `/var/cache/paperclip/git/<repo>.git`.
     - Apply ref / branch / patch from descriptor.
   - **`filestore`** (opt-in):
     - `mkdir -p /mnt/filestore/workspaces/<workspaceId>`.
     - Lease (carried in `RunDispatch`) gates concurrent access.
     - Reuse existing checkout.
3. Restore adapter session blob from `RunDispatch.sessionRestore` to the expected on-disk path.
4. Pull scoped secrets via `FetchSecrets(runId)`. Write under `/var/lib/paperclip/runs/<runId>/.env` (mode 0600, tmpfs preferred).
5. Start declared runtime services using existing `workspace-runtime.ts` logic — ephemeral starts fresh, filestore adopts existing.
6. Spawn the local CLI agent via the unchanged `*_local` process adapter code.
7. Stream stdout/stderr → `RunLog`; usage → `RunUsage`; session codec → `RunSession`.
8. On completion: `RunComplete`; tear down runtime services; `rm -rf` the run dir (ephemeral) or release the filestore lease.
9. On lease expiry / cancel / disconnect: SIGTERM → grace → SIGKILL the agent process; `RunFailed { reason }`.

### Workspace state policy

- **Default ephemeral.** Clone fresh per run; externalize session/artifacts. Most paperclip work is chat/code-task style where dev-server churn is rare; cold-start cost (5–30s) is acceptable next to multi-minute LLM runs. Workers stay stateless, autoscaling Just Works.
- **Opt-in Filestore.** Per-workspace flag `runtime: "filestore"`. NFS-mounted on every worker. A control-plane lease table (`holder_run_id`, `expires_at`) ensures only one worker mutates a workspace at a time; concurrent runs against the same workspace queue at the dispatcher.
- **Cold-start optimization.** Each worker keeps a bare-repo cache on local SSD, refreshed via `git fetch` periodically. Aim for shallow-clone-and-restore in ≤ 15s for typical repos.

## Auth and secrets

### Worker auth handshake

- Worker reads its GCP service-account identity token from the metadata server with `audience = https://paperclip.<your-domain>/workers`.
- Sends as `authorization: Bearer <id-token>` on the gRPC `Connect` call.
- Control plane verifies via `google-auth-library` (`OAuth2Client.verifyIdToken`); checks `aud`, `iss`, and that the SA email is in a configurable allowlist (default `paperclip-worker@<project>.iam.gserviceaccount.com`).
- The id-token's `instance_id` and `zone` claims provide attested instance identity, so the server knows the caller is a real MIG instance.
- On verify, server issues a 15-min paperclip-scoped JWT and embeds it in the `Welcome` frame. Worker uses it for unary RPCs (`FetchSecrets`, `ReportEvent`). Refreshed via a stream frame before expiry.

### Secrets

- Existing `secret-service` extended with `fetchScopedForRun(runId)` returning only secrets the agent is permitted to use, driven by existing `agent-permissions`.
- Worker never persists secrets beyond run lifetime. Stored under tmpfs at `/var/lib/paperclip/runs/<runId>/.env` (mode 0600), removed on cleanup.
- GCP Secret Manager backing extends naturally if configured.

## Lease and reaper

- Each `RunDispatch` carries `leaseSeconds` (default 300). Worker must send `RunLog` / `RunUsage` / `LeaseRenew` at least every `leaseSeconds/2` to hold the lease.
- `lease-reaper` cron job (existing pattern) every 30s: any `running` heartbeat run with `lease_expires_at < now()` is marked failed with reason `lease_expired`. If `attempts < maxAttempts`, re-queued for dispatch.
- Run idempotency keyed by `runId`; late completions for re-assigned runs are logged and dropped.

## Observability

- Existing `heartbeatRunEvents` table and run log store stay; gRPC frames map 1:1 onto existing event types.
- New control-plane metrics: `worker_connected_total`, `worker_inflight_runs{worker}`, `dispatch_wait_seconds{adapter}`. Drives MIG autoscaler via Cloud Monitoring custom metric (`dispatch_queue_depth = dispatched − completed`).
- New admin-only UI route `/_workers`: live workers, capacity, current runs.

## Failure modes

| Failure | Behavior |
|---|---|
| Worker crashes | Bidi stream EOF → reaper marks in-flight runs failed, requeues if attempts remain |
| Network partition | Lease expires → reaper handles |
| Server restart | Workers reconnect with exponential backoff; idempotent `RunComplete` from already-completed runs is dropped |
| MIG rolling update | `Drain` frame to outgoing instances; they finish in-flight, send `Bye`, disconnect; no run loss |
| Duplicate run dispatch | First `RunComplete` wins, second dropped (logged) |
| Worker out of capacity | Dispatcher queues until a worker slot opens or a new instance comes online |

## Phasing

1. **Worker protocol skeleton.** `.proto`, codegen, stub `Worker.Connect` server, `paperclip-worker` package. Just hello/welcome/ping/pong + no-op dispatch. Smoke-tested in-process and over loopback.
2. **One adapter end-to-end remote.** Pick `pi_local` (smallest surface). Control plane's `pi_local` adapter delegates to worker pool when a worker is registered, falls back to in-process otherwise. Validates the vertical slice.
3. **All `*_local` adapters via worker.** Extend to claude/codex/cursor/gemini/opencode. Mostly mechanical — adapter code unchanged, only execution location changes.
4. **Lease + reaper + reconnect.** Lease deadlines, reaper job, idempotent run completion. Fault-injection tests.
5. **Workspace runtime services on worker.** Port `workspace-runtime.ts` and `local-service-supervisor.ts` execution to the worker; policy/state stays on control plane DB.
6. **Filestore mode + lease coordination.** Opt-in workspace flag, lease table, dispatcher integration.
7. **GCP-native polish.** Id-token auth, MIG autoscaler custom metric, GCS-backed session/artifact store, Cloud Monitoring dashboards.

Phases 1–4 deliver a usable distributed system; 5–7 are quality.

## Testing

- **Unit:** proto roundtrip per direction; lease arithmetic; secret-scoping logic; backpressure accounting.
- **Integration:** in-process worker (same code, gRPC over loopback). The entire `*_local` adapter test suite re-runs against this configuration. No new CI dependencies.
- **Fault-injection:** kill -9 worker mid-run; drop the socket; sleep worker past its lease; send duplicate `RunComplete`. All in CI.
- **Real-MIG smoke:** `scripts/smoke-mig.sh` boots a one-instance MIG, runs a single agent end-to-end, tears down. Pre-release; doesn't gate CI.

## Risks

- **Adapter portability assumption.** Some `*_local` adapters may depend on server-only state (e.g., embedded postgres path). Mitigation: keep in-process fallback wired so a regression doesn't block users; surface in phase 2 when only `pi_local` is migrated.
- **Cold-start tax.** If shallow-clone + session-restore + service-start exceeds ~20s for typical projects, it dominates short runs. Bare-repo cache is the lever; worker warm pool is the fallback.
- **MIG autoscaling lag.** GCP autoscaler reacts in ~60s; expect queue formation for bursty workloads. Mitigation: tune minimum-instance count to typical baseline.
- **Cost vs single-server model.** One always-on worker plus the control plane is more expensive than a single-box paperclip. Document the break-even (≈ 4+ concurrent agents, or any prod use).
- **Plugin adapter compatibility.** Plugin system loads adapters dynamically. v1 ships built-in only; plugin adapters on workers are v1.1.

## Decisions following review (2026-05-08)

The following pre-phase-1 questions were resolved after a design review.

### D1. Run-log fan-out: control plane proxy in v1

Logs flow worker → control plane on the existing bidi stream and are persisted via the existing `getRunLogStore()` interface. The log store is already pluggable (in-process / disk / GCS) — for GCP deployments configure it with the GCS backend so the control plane writes through, not buffers, large log volumes.

This keeps a single auth path and a single observable channel for v1. The protocol carves out a forward-compat slot: when stream-volume becomes a real bottleneck, the server can answer a worker's first `RunLog` for a run with a (future) `LogUploadUrl` server→worker frame redirecting bulk chunks to a pre-signed GCS URL. We do not implement that frame in v1; we only commit to keeping the protocol open to it.

**Operational guideline:** size the control-plane host to handle aggregate worker log throughput. As a back-of-envelope sanity check, 8 workers × 1 MB/s sustained = 64 Mbps egress on the receive side, well within a single VM. If a deployment routinely exceeds that, switch to the side-channel path.

### D2. FetchSecrets authenticates by scope token alone

The unary `FetchSecrets(scope_token, scoped_jwt)` RPC authenticates only by `scope_token`. The token is:
- One-time-use (server invalidates on first successful exchange).
- Bound to a specific `run_id` and `agent_id`.
- Time-boxed to the run's lease window.
- Issued only at `RunDispatch` time, by the same control plane that issued the dispatch.

`scoped_jwt` remains as a reserved field for forward compatibility but is **unused in v1**. Server validates `scope_token` and ignores the JWT field. This keeps the secrets path narrowly scoped without dragging the broader stream-lifetime JWT into a per-run audit boundary.

The 15-min paperclip-scoped JWT is only used for non-secret unary RPCs added in later plans (e.g., `ReportEvent`).

### D3. MIG drain covers both rolling-update and autoscale-down

The same `Drain` server→worker frame applies to both cases. Implementation uses two GCE signals:

1. **MIG-driven drain** (rolling update or autoscale-down): the control plane subscribes to MIG instance lifecycle events (Cloud Pub/Sub topic from MIG, or the worker polls `metadata/computeMetadata/v1/instance/maintenance-event` and `…/preempted`). On detection, the control plane sends `Drain` to that worker; the worker stops accepting new dispatches, finishes in-flight runs, and disconnects.
2. **Worker self-detection**: the worker also watches its own metadata server for shutdown / preemption notice and sends a `WorkerToServer.DrainRequested` (added as a new variant) so the control plane can mark it drained immediately, even if the MIG event arrives later.

**MIG configuration requirements:**
- Instance template `goalConfig.shutdownTimeoutSec` must be ≥ longest expected run duration (default proposal: 1800s — 30 minutes — overridable via env).
- Instance template `terminationAction: STOP` (not `DELETE`) so the OS-level shutdown hook has time to send the `DrainRequested` frame.
- `Autohealing` policy must use a health check that does *not* fail during drain (`/healthz` returns 200 while draining, 503 only when fully detached).

The dispatcher refuses to send `RunDispatch` to a worker that has signaled drain (drained workers stay registered with `inFlight > 0` until their last run finishes; `pickFor()` excludes them via a new `draining` flag).

## Notes on deferred concerns

The following were raised in review and are not blockers for Phase 1, but recorded here to be settled in the noted phase. Each maps to a NOTE the implementer should consult during that phase.

| # | Concern | Disposition |
|---|---------|-------------|
| N1 | `workerId` reuse on worker restart — duplicate-Hello with stale registration. | **Phase 1, Task 5.** On `Hello`, if a worker with the same `workerId` exists, evict the prior registration (call its `disconnect()`) before registering the new one. `workerId` derives from GCE `instance_id` (durable across worker process restarts within the same instance); within an instance, a process restart with the same `workerId` is exactly the case this rule covers. |
| N2 | Run-log lease conflation: a long quiet run loses its lease. | **Phase 1, Task 12 (this is item 6 from the review and IS code-facing for phase 1).** Resolution: the worker emits an explicit `WorkerToServer.RunLeaseRenew { run_id }` heartbeat every `lease_seconds / 3` regardless of run output. Any frame referencing a `run_id` (RunLog, RunUsage, RunSession, RunLeaseRenew) renews the lease server-side. The existing `ServerToWorker.LeaseRenew` stays — it's a separate use case (server extending a grant window, e.g., budget override) — so the proto needs **both** directions. **Add `WorkerToServer.RunLeaseRenew` to `worker.proto` in Phase 1.** |
| N3 | Secrets must land on tmpfs, not regular disk. | **Phase 3 (workspace runtime services).** Worker's run-handler must verify that `/var/lib/paperclip/runs` is a tmpfs mount on startup; fail-closed if not. MIG instance template sets up tmpfs in cloud-init. |
| N4 | Single-host control plane is a SPOF. | **v2.** Out of scope. Documented limitation. HA control plane requires the heartbeat-scheduler / live-events / budget-enforcement work that already needs distributed-locking primitives — separate planning effort. |
| N5 | Burst cold-start tax (e.g., 200 issues triggered at once). | **Phase 5.** Two-lever mitigation: (a) bare-repo cache on local SSD per worker (already in spec); (b) a configurable warm-pool of pre-cloned workspaces on each worker, refilled on completion. Don't build (b) until measurements show (a) is insufficient. |
| N6 | Plugin adapters: built-in vs plugin boundary is load-bearing. | **v1.1.** Decision: plugin adapters on workers will use the same dispatch boundary, but the worker image needs a plugin loader. Defer the design to v1.1 spec; surface impact when a plugin user reports the gap. If `paperclip` trajectory turns out to be plugin-first, escalate to v1 critical-path. |
| N7 | Quota / fairness across companies. | **v1.5.** Single-tenant assumption for v1. Multi-tenant deployments need a per-company queue or fair-share scheduling at the dispatcher; defer until a multi-tenant deployment exists. Document the gap. |
| N8 | Run cost during instance-replacement (double-billing on retry). | **Phase 4 (lease-reaper).** Add `replay_count` integer to `heartbeat_runs`. Dashboard shows it next to cost. Don't change billing math; surface the truth so users can audit. |
| N9 | Concrete sizing assumptions. | **Phase 5 (GCP polish).** Publish a sizing table. Working assumption pending measurement: `n2-standard-2` per worker, ~1 concurrent run per worker for code-heavy adapters; control plane on `n2-standard-4` handles ≤ 16 connected workers with proxy-mode logs. |
| N10 | Lease state-machine test scenarios. | **Phase 4 (lease-reaper).** Enumerate explicitly: (a) lease expires while RunLog is mid-flight; (b) control plane reassigns then original worker reconnects with stale state; (c) two RunCompletes racing for the same `run_id`; (d) Drain mid-run; (e) FetchSecrets after the run was already reassigned. Each gets a fault-injection test. |

## Open questions

- Where exactly does the control plane run? GCE VM, GKE pod, or Cloud Run? Cloud Run supports gRPC bidirectional streaming but with timeout caveats; GCE/GKE has no such limit. Defaulting to GCE VM in the same VPC for v1.
- Should we expose the worker registry's state in the existing instance-settings UI, or only via a new admin route?
- Do we want a worker-side "self-update" path, or rely solely on MIG image rollouts?
