# Distributed Workers GCP Polish Implementation Plan (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the distributed-workers spec (phase 7 in the design doc) — GCP-native deployment polish, the operational surface that makes a multi-worker fleet legible, and the deferred items from Plans 3 + 4 that this plan can land cheaply. Adapter scope unchanged from Plans 1-4: claude_local + gemini_local only.

**Architecture:** Three workstreams that share the same control-plane-side wiring pattern (gRPC server / dispatcher / registry are already in place from Plans 1-2):

1. **Operational surface.** Read-only `/api/_workers` endpoint exposes the in-memory registry; admin `/_workers` UI route renders connected workers + capacity + in-flight runs. Manual drain trigger via `POST /api/_workers/:id/drain` sends a `Drain` frame on the worker's bidi stream (the worker-side handling from Plan 2 Task 6 is already wired). SIGTERM auto-drain at server boot drains every connected worker before HTTP listener close, so a control-plane rolling restart loses nothing in flight.
2. **Custom autoscaler metric.** Process-internal accounting of (queue_depth, inflight_runs, available_capacity) gets published every 60s to Cloud Monitoring as a custom metric. The MIG autoscaler subscribes to that metric — high queue depth scales workers up; low scales down. Spec D3 explicitly excludes draining workers from "available capacity" so the signal doesn't under-provision during a rolling update.
3. **GCS-backed session + artifact store.** Plan 1 stubbed `RunDispatch.session_restore` as in-memory bytes; Plan 5 routes large session blobs through the existing `server/src/storage/` provider abstraction (already supports `local_disk` and `s3`). New `gcs` provider option mirrors the s3-provider shape. RunComplete summary archives, run-log tail blobs, and worker session restores all flow through the same provider so deployments pick one storage backend across the board.

**Tech Stack:** Adds `@google-cloud/monitoring` (custom metric publisher) and `@google-cloud/storage` (GCS provider) as opt-in deps. Both are server-side only; the worker doesn't talk to GCP storage directly (the worker fetches session bytes through the control plane via the existing FetchSecrets-shaped channel — extended in Task 7).

**Scope split (this plan covers Plan 5 of 5 — final plan in the spec):**
- ✅ This plan: read-only admin surface, drain trigger + SIGTERM auto-drain, custom autoscaler metric publisher, GCS storage provider, worker session/artifact blobs through provider, end-to-end smoke.
- 🚫 No further plans for distributed workers. The spec's 7 phases close here.

**Explicitly NOT in this plan** (continues Plans 1-4 scope; carved out as separate work):
- **Cross-VM port exposure for UI-triggered service preview.** Plan 3 deferred this; Plan 5 doesn't ship a load balancer / tunnel solution either. The `/_workers` UI shows worker status; service preview URLs that point at a worker IP / port still don't traverse the control-plane / worker network split. A follow-up product plan owns this — it's GCP-LB / Cloud Run / tailscale-style territory, not distributed-workers polish.
- **Cross-worker runtime service reuse.** Plan 4 enabled the workspace half (filestore mode); the service-host design (network-addressable services discoverable across workers) is its own design exercise. Today each worker still owns its own service stack.
- **Migrating remaining `*_local` adapters.** Excluded at user request.
- **Read-only replicas of Filestore.** Plan 4 punted; not in scope here.

---

## File Structure

**Created:**
- `server/src/routes/_workers.ts` — admin read-only endpoint + drain trigger.
- `server/src/routes/__tests__/_workers.test.ts`
- `server/src/services/worker-metrics.ts` — process-local accounting (`current()` returns `{queueDepth, inflightRuns, availableCapacity}`).
- `server/src/services/__tests__/worker-metrics.test.ts`
- `server/src/services/cloud-monitoring-publisher.ts` — opt-in metric writer.
- `server/src/services/__tests__/cloud-monitoring-publisher.test.ts`
- `server/src/services/server-drain.ts` — SIGTERM hook that drains every connected worker before close.
- `server/src/services/__tests__/server-drain.test.ts`
- `server/src/storage/gcs-provider.ts` — GCS storage provider matching the existing s3-provider shape.
- `server/src/storage/__tests__/gcs-provider.test.ts` (mocked GCS client; integration test deferred to a real-GCP smoke).
- `ui/src/pages/admin/Workers.tsx` — read-only admin page.

**Modified:**
- `server/src/storage/provider-registry.ts` — register `gcs` alongside `local_disk` + `s3`.
- `server/src/config.ts` — `PAPERCLIP_GCP_PROJECT`, `PAPERCLIP_GCP_MONITORING_ENABLED`, `PAPERCLIP_STORAGE_GCS_BUCKET`, etc.
- `server/src/index.ts` — wire metrics-publisher (60s setInterval), worker-drain SIGTERM hook, `/api/_workers` route registration.
- `server/src/services/run-dispatcher.ts` — bumps the `worker-metrics` accounting on `tryDispatch` / `markCompleted` so the publisher reads accurate counts.
- `packages/worker-rpc/proto/paperclip/v1/worker.proto` — extend `RunDispatch.session_restore` shape so it can carry a storage URI instead of inline bytes (or add a `session_restore_uri` field; inline stays for ephemeral). The worker's run-handler resolves the URI via the existing FetchSecrets-shaped path.

**Migration:** None.

---

## Conventions used in this plan

Same as Plans 1-4:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Commit style:** conventional commits — `feat(server): ...`, `feat(ui): ...`, `chore(storage): ...`. Co-author: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch** off the previous task's branch. TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: Read-only `/api/_workers` endpoint

**Files:**
- Create: `server/src/routes/_workers.ts`
- Create: `server/src/routes/__tests__/_workers.test.ts`
- Modify: `server/src/app.ts` (or wherever routes are registered) — mount the new router.

Returns the in-memory `WorkerRegistry` snapshot:

```json
{
  "workers": [
    {
      "workerId": "worker-1",
      "instanceId": "i-abc",
      "adapters": ["claude_local", "gemini_local"],
      "maxConcurrent": 1,
      "inFlight": 0,
      "draining": false,
      "connectedAt": "2026-05-12T..."
    }
  ],
  "summary": {
    "totalConnected": 2,
    "totalCapacity": 2,
    "inflightRuns": 0,
    "draining": 0
  }
}
```

- [ ] **Step 1: Write failing tests.** Mock the registry; assert the route returns the right shape, including the draining flag.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Auth: instance-admin only (check the existing access-service pattern).
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 2: Manual drain trigger — `POST /api/_workers/:id/drain`

**Files:**
- Modify: `server/src/routes/_workers.ts` — add the drain route.
- Modify: `server/src/services/worker-registry.ts` — expose a `requestDrain(workerId)` method that flips the in-memory `draining` flag AND calls `worker.send(Drain)` on the bidi stream.
- Modify: `server/src/services/__tests__/worker-registry.test.ts`
- Modify: `server/src/routes/__tests__/_workers.test.ts`

Sends `ServerToWorker.Drain` to the named worker. Worker-side handling (Plan 2 Task 6) finishes in-flight runs, then ends the stream cleanly. Returns 202 immediately; the actual drain completion flows back as a stream-end event the registry handles via `unregister`.

- [ ] **Step 1: Write failing tests** for the registry method (sends Drain, flips flag) and the route (404 on unknown id, 202 on success).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 3: SIGTERM auto-drain at server boot

**Files:**
- Create: `server/src/services/server-drain.ts`
- Create: `server/src/services/__tests__/server-drain.test.ts`
- Modify: `server/src/index.ts` — register the SIGTERM hook before `server.listen`.

`drainAllWorkers({ registry, gracePeriodMs })`: for each registered worker, send `Drain`; await stream-end (with a hard cap so a stuck worker doesn't block control-plane shutdown). Returns when every worker has either drained or hit the timeout.

- [ ] **Step 1: Write failing tests.** Stub registry returns three workers; observe that all three receive Drain; resolves when all unregister; honors gracePeriodMs.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 4: `worker-metrics` accounting

**Files:**
- Create: `server/src/services/worker-metrics.ts`
- Create: `server/src/services/__tests__/worker-metrics.test.ts`
- Modify: `server/src/services/run-dispatcher.ts` — `recordDispatch` / `recordSettle` calls into worker-metrics so the publisher reads accurate counts.

Pure in-process accounting: `current()` returns `{ queueDepth, inflightRuns, availableCapacity }`. Spec D3: `availableCapacity = sum(maxConcurrent - inFlight) over non-draining workers` — draining workers are excluded so the autoscaler doesn't see "I have N workers" while M of them are draining.

- [ ] **Step 1: Write failing tests** for the accounting math (3 workers, 1 draining, various inflight states → expected totals).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Reads from the registry on `current()` so we don't have to maintain a separate in-process count.
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 5: Cloud Monitoring publisher

**Files:**
- Create: `server/src/services/cloud-monitoring-publisher.ts`
- Create: `server/src/services/__tests__/cloud-monitoring-publisher.test.ts`
- Modify: `server/src/index.ts` — wire a 60s setInterval when `PAPERCLIP_GCP_MONITORING_ENABLED=true`.
- Modify: `server/package.json` — add `@google-cloud/monitoring` as opt-in dep.

`publishMetrics({ projectId, getCurrent })` writes a `custom.googleapis.com/paperclip/queue_depth` time-series point. Tests inject a fake `MetricServiceClient` so no GCP calls happen in CI.

The published metric drives the MIG autoscaler — typical config: target queue_depth=0 with a buffer, scale up when depth > threshold for >60s, scale down when depth=0 for >5min.

- [ ] **Step 1: Add `@google-cloud/monitoring`** via `pnpm --filter @paperclipai/server add @google-cloud/monitoring`.
- [ ] **Step 2: Write failing tests** with the fake MetricServiceClient.
- [ ] **Step 3: RED.**
- [ ] **Step 4: Implement.** Lazy-import `@google-cloud/monitoring` so unit tests that don't exercise the publisher don't pay the load cost (precedent: Plan 1 Task 14's `gcpIdTokenAuthStrategy`).
- [ ] **Step 5: GREEN, typecheck, commit + push.**

---

## Task 6: GCS storage provider

**Files:**
- Create: `server/src/storage/gcs-provider.ts`
- Create: `server/src/storage/__tests__/gcs-provider.test.ts`
- Modify: `server/src/storage/provider-registry.ts`
- Modify: `server/src/storage/types.ts` — make sure the provider interface accommodates GCS bucket-key URIs cleanly.
- Modify: `server/package.json` — add `@google-cloud/storage` as opt-in dep.

Mirror `s3-provider.ts` shape: `put(key, data)`, `get(key)`, `delete(key)`, `signedUrl(key, ttlSec)`. Same interface every existing storage call site uses; the only environmental switch is `PAPERCLIP_STORAGE_PROVIDER=gcs` + `PAPERCLIP_STORAGE_GCS_BUCKET`.

- [ ] **Step 1: Add `@google-cloud/storage`.**
- [ ] **Step 2: Write failing tests** mocking the GCS Bucket client.
- [ ] **Step 3: RED.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: GREEN, typecheck, commit + push.**

---

## Task 7: Session blob via storage provider

**Files:**
- Modify: `packages/worker-rpc/proto/paperclip/v1/worker.proto` — add `session_restore_uri` alongside the existing `session_restore` bytes; one or the other.
- Modify: `server/src/services/run-dispatcher.ts` — when a session blob is large (e.g., > 1MB), write to storage and dispatch the URI; small blobs continue to ride inline.
- Modify: `packages/worker/src/run-handler.ts` — when `session_restore_uri` is set, fetch via the existing FetchSecrets-shaped unary RPC (a new `FetchBlob` RPC mirroring its scope-token contract is the natural shape — but for v1 we can just signed-URL the storage path and let the worker `fetch()` it).
- Tests on both sides.

The threshold + URI vs inline split keeps small ephemeral runs cheap (no extra roundtrip) while letting large session restores survive without pinning the gRPC stream's max message size.

- [ ] **Step 1: Decide URI auth model.** Two options:
  - (a) Signed URL with short TTL — simplest; the worker `fetch()`es directly.
  - (b) New `FetchBlob` RPC mirroring `FetchSecrets`'s scope-token contract.
  - **Recommend (a)** for v1 — fewer moving parts; the URL is run-scoped + short-lived which matches `secrets-scope-token` semantics on a different surface.
- [ ] **Step 2: Proto edit + codegen.**
- [ ] **Step 3: Write failing tests** for both sides.
- [ ] **Step 4: RED.**
- [ ] **Step 5: Implement.**
- [ ] **Step 6: GREEN, typecheck, commit + push.**

---

## Task 8: Admin `/_workers` UI page

**Files:**
- Create: `ui/src/pages/admin/Workers.tsx`
- Modify: `ui/src/App.tsx` (or routes file) — register the route under `/admin/workers`.

Read-only page hitting `/api/_workers` every 5 seconds. Shows a table of connected workers with `workerId`, `instanceId`, `adapters`, `inFlight / maxConcurrent`, `draining` flag, and a "Drain" button per row that POSTs to `/api/_workers/:id/drain`.

This is the operator's visibility into the fleet. The styling can stay intentionally plain — admin UI doesn't need to match the rest of the product's polish.

- [ ] **Step 1: Snapshot/render test** asserting the table renders the worker list correctly given a fake API response.
- [ ] **Step 2: Implement.** Reuse existing query hooks + table primitives.
- [ ] **Step 3: Manual smoke** — start the server with `WORKER_GRPC_ENABLED=true`, connect a worker, navigate to `/admin/workers`, click Drain, observe the worker disconnects.
- [ ] **Step 4: Commit + push.**

---

## Task 9: End-to-end smoke

**Files:**
- Modify: `server/src/__tests__/distributed/end-to-end.test.ts` — add a fourth case.

Drives the full operational surface: connect a worker, dispatch a run, hit `POST /api/_workers/:id/drain`, observe the worker finishes the in-flight run + ends the stream + the row is gone from the registry. Then publish metrics; assert the publisher's mock `createTimeSeries` call was made with the expected shape.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: GREEN. Commit + push.**

---

## Task 10: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1:** `pnpm -r build` and `pnpm --filter '!@paperclipai/server' -r test` — green.
- [ ] **Step 2:** Targeted server: `pnpm --filter @paperclipai/server exec vitest run src/services/__tests__/ src/worker-rpc/__tests__/ src/__tests__/distributed/ src/adapters/__tests__/ src/routes/__tests__/_workers.test.ts src/storage/__tests__/`. All pass.
- [ ] **Step 3:** Update `ROADMAP.md` Cloud / Sandbox agents bullet — flip the milestone status from in-progress to done; mention all 5 phases shipped.
- [ ] **Step 4:** Commit + push.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** spec phase 7 ("GCP-native polish — id-token auth, MIG autoscaler custom metric, GCS-backed session/artifact store, Cloud Monitoring dashboards") is exercised end-to-end. Id-token auth landed in Plan 1 Task 14 + Plan 1 Task 15; this plan adds the metric, the storage provider, and the operational surface.
- [ ] **No placeholders:** zero hits for "TBD", "TODO", "implement later".
- [ ] **Type consistency:** `workerId` / `worker_id`, `runtime_service_id` / `runtimeServiceId`, etc., consistent across new files and proto.
- [ ] **Commit hygiene:** every task ends green (`pnpm -r build && targeted tests`).
- [ ] **No new adapters added.** claude_local + gemini_local remain the only adapters wired through the dispatch-or-local seam.
- [ ] **All 7 spec phases done.** Phase 1 (foundation) ✅, Phase 2 (durability) ✅, Phase 3 = our adapter-rollout deferral, Phase 4 (lease + reaper + reconnect) ✅ (folded into Plan 2), Phase 5 (workspace runtime services) ✅, Phase 6 (filestore) ✅, Phase 7 (GCP polish) ✅ on this plan.

## What's not done after this plan

The original distributed-workers spec is closed. Items below are new product surface, not unfinished spec phases:

- **Cross-VM port exposure for UI-triggered service preview.** Plan 3 deferred; Plan 5 also defers. Owns the LB/tunnel design. Lives outside the distributed-workers spec.
- **Cross-worker runtime service reuse.** Plan 4 enabled the workspace half (filestore mode); the service-host topology that lets a service started on worker-A be reachable from worker-B is its own design exercise. Lives outside the distributed-workers spec.
- **Cloud Monitoring dashboard JSON.** Task 5 publishes the metric; an actual dashboard config (panels, thresholds, alert policies) is operations work that varies by deployment shape, not a code change to ship in core.
- **Live mode toggle (ephemeral ↔ filestore).** Plan 4 deferred; outside the spec.
- **Read replicas of Filestore.** Plan 4 deferred; outside the spec.
- **Migrating remaining `*_local` adapters** (codex_local, cursor, opencode_local, acpx_local, openclaw_gateway, pi_local). Excluded at user request — they stay on the in-process fall-back path. Each is mostly mechanical (one `createDispatchOrLocal` wrapper) when the team needs them.
