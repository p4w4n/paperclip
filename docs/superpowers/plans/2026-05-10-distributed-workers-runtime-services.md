# Distributed Workers Runtime Services Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `claude_local` / `gemini_local` run is dispatched to a worker, any runtime services declared in the agent's config (`npm run dev`, embedded postgres, etc.) start on the **worker** (where the realized ephemeral workspace lives), not on the control plane. Status flows back to the control plane via gRPC frames; the canonical state on `workspace_runtime_services` stays where the spec wants it ("policy/state on control plane DB"). Adapter scope unchanged from Plans 1 + 2: claude_local + gemini_local only.

**Architecture:** `server/src/services/workspace-runtime.ts` (~3000 lines) + `local-service-supervisor.ts` are split along a new seam — the **policy half** (selecting which services to start, lease accounting across reuse-keys, DB row writes) stays on the control plane; the **execution half** (`spawn`, port detection, healthcheck polling, SIGTERM on stop) moves to the worker as a small supervisor. The `RunDispatch` proto gains a `runtime_services` field carrying the resolved spec list (commands, env, healthcheck, port hints). The worker's `run-handler` realizes the workspace → starts services → invokes the adapter → stops services in `finally`. New `ServiceStatus` worker-to-server frames stream readiness/error transitions; the connect-handler maps them into Drizzle updates against `workspace_runtime_services`. Worker death = services die (no DB churn needed; the heartbeat scheduler already marks runs failed via the lease reaper from Plan 2).

**Tech Stack:** No new dependencies. Reuses Plan 1's proto + Plan 2's reaper hook for cleanup-on-worker-death. Worker-side supervisor uses Node's `child_process.spawn` and `net.connect` for port probes.

**Scope split (this plan covers Plan 3 of 5):**
- ✅ This plan: per-run service execution moved to the worker, status reporting back to DB, automatic teardown on run end, automatic teardown on lease expiry (worker death scenario already covered by Plan 2's reaper — this plan adds the "stop services for that run" branch on the worker end).
- ⏭ Plan 4: filestore opt-in mode + cross-worker workspace lease (lets services be reused across workers, today they're per-worker only).
- ⏭ Plan 5: GCP-native polish — autoscaler custom metric, GCS-backed session/artifact store, Cloud Monitoring dashboards, admin `/_workers` UI, **cross-VM port exposure for UI-triggered service preview** (today the manual "Start dev server" routes still run in-process; Phase 5 wires LB or tunnel so the URL works across the control-plane / worker split).

**Explicitly NOT in this plan** (continues Plan 1 + Plan 2 scope):
- Migrating remaining `*_local` adapters to the worker (`codex_local`, `cursor`, `opencode_local`, `acpx_local`, `openclaw_gateway`, `pi_local`).
- Manual UI-triggered service start via `routes/projects.ts` and `routes/execution-workspaces.ts` — these stay control-plane-only for v3; they simply don't apply to runs that ended up on a worker.
- Cross-worker service reuse (the existing in-process implementation reuses the same dev server across runs by `reuseKey`; on workers, each worker starts its own).

---

## File Structure

**Created:**
- `packages/worker-rpc/proto/paperclip/v1/worker.proto` — extended with `RuntimeServiceSpec`, `ServiceStatus` (worker→server), and a `runtime_services` repeated field on `RunDispatch`. (Single migration file in proto; codegen flushes through `pnpm --filter @paperclipai/worker-rpc build`.)
- `packages/worker/src/services-supervisor.ts` — minimal port of `local-service-supervisor.ts`: spawn / track / port-probe / SIGTERM. ~200 lines target. No DB, no reuse cache.
- `packages/worker/src/__tests__/services-supervisor.test.ts`
- `packages/worker/src/services-runner.ts` — given a `RuntimeServiceSpec[]`, starts each, awaits readiness (port-bound or healthcheck-passed), reports status back via the `send` callback on success/failure, and exposes a `stopAll(runId)` for the run handler's `finally`.
- `packages/worker/src/__tests__/services-runner.test.ts`
- `server/src/services/runtime-services-dispatch.ts` — pure function that takes the existing `selectRuntimeServiceEntries` + `resolveServiceScopeId` outputs and produces a `RuntimeServiceSpec[]` payload for the proto. Tests pin the projection without touching DB.
- `server/src/services/__tests__/runtime-services-dispatch.test.ts`
- `server/src/worker-rpc/service-status-handler.ts` — connect-handler branch: maps inbound `ServiceStatus` frames to Drizzle `update(workspaceRuntimeServices).set(...)`.
- `server/src/worker-rpc/__tests__/service-status-handler.test.ts`

**Modified:**
- `packages/worker-rpc/src/index.ts` — re-export the new schemas.
- `server/src/services/workspace-runtime.ts` — `ensureRuntimeServicesForRun` learns a new branch: if `dispatchedToWorkerId` is set on the run (i.e., the dispatch-or-local seam picked a worker), build the spec via `runtime-services-dispatch.ts` and stash it on the dispatch context so `RunDispatcher.tryDispatch` can carry it on the proto frame. The legacy in-process path (no worker) keeps its existing behavior unchanged.
- `server/src/services/run-dispatcher.ts` — `DispatchInput` gains an optional `runtimeServices: RuntimeServiceSpec[]`; `tryDispatch` includes them on the `RunDispatch` frame.
- `server/src/worker-rpc/connect-handler.ts` — handle the new `serviceStatus` case alongside `runComplete` / `runFailed`. Same late-frame drop gate from Plan 2 Task 4 applies (drop status from a worker that no longer owns the run).
- `packages/worker/src/run-handler.ts` — wraps adapter execution: realize workspace → run services-runner.startAll(spec) → runAdapter → finally services-runner.stopAll(runId). Failure to start a service produces a `RunFailed` with `errorCode: "service_start_failed"` so the dispatch-or-local seam falls back to local execution rather than burning the run.
- `packages/worker/src/index.ts` — pass `services-runner.send` closure into the `run-handler` deps so status frames flow on the same bidi stream the dispatch arrived on.

**Migration:** None. `workspace_runtime_services` schema is unchanged; we're only changing who writes to it and from where.

---

## Conventions used in this plan

Same as Plans 1 + 2:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Proto codegen:** `pnpm --filter @paperclipai/worker-rpc build` regenerates `src/generated/...`. Commit the generated code alongside the proto change.
- **Commit style:** conventional commits — `feat(worker): ...`, `feat(server): ...`, `chore(worker-rpc): ...`. Co-author: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch** off the previous task's branch. TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: Proto contract for runtime services

**Files:**
- Modify: `packages/worker-rpc/proto/paperclip/v1/worker.proto`
- Modify: `packages/worker-rpc/src/index.ts` — re-export new schemas

Add three message types and one field:

```proto
message RuntimeServiceSpec {
  string runtime_service_id = 1; // canonical id from workspace_runtime_services row
  string service_name = 2;
  string command = 3;            // shell command line, run via /bin/sh -c
  string cwd = 4;                // already realized workspace cwd
  map<string, string> env = 5;
  // Readiness signal: zero or one of these populated. If both empty,
  // the worker treats `started` as ready.
  uint32 ready_port = 6;         // poll until tcp connect succeeds
  string ready_healthcheck_url = 7;
  uint32 readiness_timeout_sec = 8; // default 60
}

message ServiceStatus {
  string run_id = 1;
  string runtime_service_id = 2;
  // starting | running | failed | stopped
  string state = 3;
  // Populated when the worker has bound a port (port_owner detection).
  uint32 bound_port = 4;
  string url = 5;
  string error = 6;
  string error_code = 7;
  // PID lives on the worker; only useful in worker-local logs.
  uint32 pid = 8;
}

// New repeated field on RunDispatch:
repeated RuntimeServiceSpec runtime_services = 9;
// New oneof variant on WorkerToServer.payload:
ServiceStatus service_status = 13;
```

- [ ] **Step 1:** Edit the proto.
- [ ] **Step 2:** Run `pnpm --filter @paperclipai/worker-rpc build` and verify codegen produces `RuntimeServiceSpecSchema`, `ServiceStatusSchema` types in `src/generated/...`. Re-export from `src/index.ts`.
- [ ] **Step 3:** Whole-repo `pnpm -r typecheck` — green (the new fields are added, not breaking).
- [ ] **Step 4:** Commit + push.

---

## Task 2: Worker-side process supervisor

**Files:**
- Create: `packages/worker/src/services-supervisor.ts`
- Create: `packages/worker/src/__tests__/services-supervisor.test.ts`

A thin wrapper over `child_process.spawn` that tracks running processes by `runtimeServiceId`, exposes `start(spec) → { pid }`, `stop(serviceId)`, `stopAllFor(runId)`, and emits a `closed` promise per service so the runner (Task 3) can detect crash exits.

No DB, no reuse cache, no adopting orphan services. ~200 lines target. The control plane's `local-service-supervisor.ts` keeps a registry file (`.paperclip-services.json`) for its own reasons; worker-side we don't need that — workers are stateless, a worker death = process death.

- [ ] **Step 1:** Write failing test: spawn a `node -e 'setInterval(()=>{},1000)'` service, assert `stop()` actually kills it (`process.kill(0, pid)` after stop should throw ESRCH).
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 3: Worker-side services runner (port probe + healthcheck)

**Files:**
- Create: `packages/worker/src/services-runner.ts`
- Create: `packages/worker/src/__tests__/services-runner.test.ts`

Layered on top of the supervisor: given a list of `RuntimeServiceSpec`, start each, then poll for readiness:
- `ready_port` set → repeatedly `net.connect(port)` until success or timeout.
- `ready_healthcheck_url` set → repeatedly `fetch(url)` and check 2xx.
- Neither set → mark ready as soon as `start()` returns a PID.

For each transition (`starting` → `running` / `failed` / `stopped`), call the injected `send` callback with a `ServiceStatus` frame. Tests inject a fake spawn (a no-op promise that resolves with a fake PID), a fake port-probe, and a fake `send`, so no real process or socket is involved.

Exposes `startAll(runId, specs[]) → Promise<void>` (resolves when all are running, rejects with the first failure) and `stopAllFor(runId)` for the run handler's `finally`.

- [ ] **Step 1:** Write failing tests:
  - All services ready → `startAll` resolves; status frames `[starting, running]` per service.
  - One service fails port-probe within timeout → `startAll` rejects; status frame `failed`; previously-started services are stopped (rollback semantics).
  - `stopAllFor(runId)` stops every running service for that run; absent runs no-op.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 4: Wire services into worker run-handler

**Files:**
- Modify: `packages/worker/src/run-handler.ts`
- Modify: `packages/worker/src/__tests__/run-handler.test.ts`
- Modify: `packages/worker/src/index.ts` — pass `services-runner` via deps

Run handler's lifecycle becomes: realize workspace → fetch secrets → **start services** → run adapter → finally **stop services** → cleanup workspace.

A service-start failure becomes `RunFailed { errorCode: "service_start_failed" }` so the dispatch-or-local fallback re-tries the run in-process (where Phase 1's local execution still has the existing `ensureRuntimeServicesForRun` working). This preserves the OSS single-host story when a worker can't satisfy the service requirements (e.g., wrong base image).

- [ ] **Step 1:** Write failing test: a dispatch with one `runtime_services` entry → `services-runner.startAll` is called with the spec → adapter is invoked with the running env → on adapter exit, `services-runner.stopAllFor` is called from `finally`.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement; reuse the existing fake `services-runner` from Task 3 tests via the deps shape.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 5: Server-side dispatch projection — build `RuntimeServiceSpec[]`

**Files:**
- Create: `server/src/services/runtime-services-dispatch.ts`
- Create: `server/src/services/__tests__/runtime-services-dispatch.test.ts`

Pure function: given the existing `selectRuntimeServiceEntries(config)` + a `RealizedExecutionWorkspace` + `adapterEnv` + the resolved `runtimeServiceId` per service, produce `RuntimeServiceSpec[]`. No DB I/O — the caller (Task 6 wiring) supplies already-resolved entries; this layer only translates shapes.

Pinning the projection in a pure function keeps the tests free of `workspace_runtime_services` table fixtures, and makes future evolution of the dispatch payload (e.g., per-service secrets in Phase 4) a single-file change.

- [ ] **Step 1:** Write failing tests:
  - Single service → single spec entry, env merged correctly, port + timeout populated.
  - Multiple services → preserved order.
  - Service with no port → `ready_port = 0` (the worker treats this as "ready when started").
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 6: Server-side wiring — send services on RunDispatch

**Files:**
- Modify: `server/src/services/run-dispatcher.ts` — `DispatchInput` gains `runtimeServices?: RuntimeServiceSpec[]`; `tryDispatch` includes them on the `RunDispatch` frame.
- Modify: `server/src/services/workspace-runtime.ts` — `ensureRuntimeServicesForRun` learns to short-circuit when the run is being dispatched to a worker. Returns the spec list instead of starting locally; the dispatch-or-local seam carries it onto the proto frame.
- Modify: `server/src/adapters/dispatch-or-local.ts` — pass `runtimeServices` from the `ensureRuntimeServicesForRun` call into the dispatcher.

The control plane still pre-creates `workspace_runtime_services` rows (so the UI immediately sees the services as "starting" and the lease reaper from Plan 2 has rows to reconcile against on worker death). The worker's later `ServiceStatus` frames flip those rows to `running` / `failed` / `stopped`.

- [ ] **Step 1:** Write failing test: a tryDispatch with `runtimeServices: [{ ...one entry... }]` → the worker's `send` mock receives a `RunDispatch` frame whose `runtime_services[0]` matches.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 7: Server-side `ServiceStatus` handler

**Files:**
- Create: `server/src/worker-rpc/service-status-handler.ts`
- Create: `server/src/worker-rpc/__tests__/service-status-handler.test.ts`
- Modify: `server/src/worker-rpc/connect-handler.ts` — route `serviceStatus` payload variant
- Modify: `server/src/worker-rpc/__tests__/connect-handler.test.ts`

Inbound `ServiceStatus` frames map to a `db.update(workspaceRuntimeServices).set({ state, boundPort, url, errorCode, ... }).where(eq(id, runtimeServiceId))`. Plan 2 Task 4's late-frame drop gate applies — if the sender's `workerId` doesn't match the row's `dispatchedToWorkerId` for the run, drop the status frame.

- [ ] **Step 1:** Write failing tests:
  - `state = "running"` → row updated with `boundPort` + `url`.
  - `state = "failed"` → row updated with `errorCode` + `error`.
  - Late frame from non-current worker → row not updated, log line emitted.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement (extract the row-update logic into the standalone module so the test doesn't need a real Drizzle handle).
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 8: Lease reaper extension — stop services on worker death

**Files:**
- Modify: `server/src/services/lease-reaper.ts` — settle callback now includes a "mark services stopped for this run" effect.
- Modify: `server/src/index.ts` — production wire updates `workspace_runtime_services` rows for the expired run on top of the existing lease-expiry handling.
- Modify: `server/src/services/__tests__/lease-reaper.test.ts` — settle callback receives the runId; production wire stops services.

When a worker dies and the lease reaper from Plan 2 fires, the runtime services for that run are dead too (the worker was the host process). DB rows need to be flipped from `running` → `stopped` (or `failed` if the run is also failing) so the UI doesn't show dead services as live, and so a re-dispatch from Plan 2 Task 3 starts fresh.

- [ ] **Step 1:** Write failing test: lease expiry settlement → for any `workspace_runtime_services` row joined on `runId`, status flips to `stopped`.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement; the reaper's settle callback already runs in the production wire, so we add a single `db.update(workspaceRuntimeServices).set({ state: "stopped" }).where(eq(runId, expired.runId))` call.
- [ ] **Step 4:** GREEN. Commit + push.

---

## Task 9: End-to-end integration test

**Files:**
- Modify: `server/src/__tests__/distributed/end-to-end.test.ts` — add a second case that drives a dispatch with `runtimeServices`.

Spec the e2e: spin up the gRPC server on a loopback port, connect a real worker client whose run-handler is wired to a fake services-runner, dispatch with `runtime_services: [{ command: "noop", ready_port: 0 }]`, assert the dispatcher's `onSettlement` listener fires `complete` AND assert the test's services-runner saw `startAll` then `stopAllFor`.

This pins the two-way wire: services flow out on `RunDispatch`, status flows back on `ServiceStatus`, and the cleanup ordering is observed.

- [ ] **Step 1:** Write the test.
- [ ] **Step 2:** GREEN (it should pass — Tasks 1-7 already wired both halves).
- [ ] **Step 3:** Commit + push.

---

## Task 10: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1:** `pnpm -r build` and `pnpm --filter '!@paperclipai/server' -r test` — green.
- [ ] **Step 2:** Targeted server: `pnpm --filter @paperclipai/server exec vitest run src/services/__tests__/ src/worker-rpc/__tests__/ src/__tests__/distributed/`. All pass.
- [ ] **Step 3:** Update `ROADMAP.md` Cloud / Sandbox agents bullet to mention runtime services landed.
- [ ] **Step 4:** Commit + push.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** every workspace-runtime concern the spec calls out for "phase 5: workspace runtime services on worker" is exercised — process supervision, port detection, lifecycle tied to run, status visibility on the control plane.
- [ ] **No placeholders:** zero hits for "TBD", "TODO", "implement later".
- [ ] **Type consistency:** `runtime_service_id` / `runtimeServiceId` matches across proto, worker, server, DB.
- [ ] **Commit hygiene:** every task ends green (`pnpm -r build && targeted tests`).
- [ ] **No new adapters added.** `claude_local` and `gemini_local` remain the only adapters wired through the dispatch-or-local seam.

## What's not done after this plan

- **Cross-worker service reuse.** A run on worker-A can't reuse a service started by worker-B; each worker owns its own service stack. The existing in-process path keeps `runtimeServicesByReuseKey`, the worker path doesn't. This is acceptable because workers in Phase 3 are stateless single-tenant processes; reuse is a Phase 4 concern that piggy-backs on filestore mode.
- **UI-triggered service start.** `routes/projects.ts` and `routes/execution-workspaces.ts` still call the in-process `startRuntimeServicesForWorkspaceControl`. A user clicking "Start dev server" on a project whose runs are dispatched to workers will get the service running on the control plane VM — useless for previewing if the workspace lives on the worker. The ergonomic fix lands with cross-VM port exposure (LB / tunnel) in Plan 5.
- **`reconcilePersistedRuntimeServicesOnStartup`.** The control plane still runs this on boot for in-process services; worker-side processes don't survive a worker restart so there's nothing to reconcile. We make no claim of cross-restart persistence on the worker side.
- **Per-service scoped secrets.** Today services receive the same `adapterEnv` as the run; per-service secret resolution is queued for Phase 4 alongside the broader secrets refactor.
- **Remaining `*_local` adapters.** Excluded at user request — they stay on the in-process fall-back path.
