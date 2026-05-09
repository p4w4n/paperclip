# Distributed Workers Filestore Mode Implementation Plan (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in **filestore mode** for project workspaces. When enabled, the workspace lives at a stable shared path (NFS mount, GCP Filestore, or any filesystem visible to every worker) rather than being shallow-cloned per-run on each worker. Concurrent runs on the same workspace are serialized via a **workspace lease** in the DB so two workers can't write to the same files at once. Adapter scope unchanged from Plans 1-3: claude_local + gemini_local only.

**Architecture:** Phase 1 introduced ephemeral per-run workspace realization on the worker (shallow clone → temp dir → adapter → cleanup). Phase 4 adds a parallel realization path: when a project's `project_workspaces` row has filestore mode enabled, the worker doesn't clone — it just takes the shared path that's mounted at a known location on every worker (configured via `PAPERCLIP_FILESTORE_ROOT`). The dispatch-or-local seam acquires a workspace lease before dispatching; if the lease is unavailable (another run holds it), `tryDispatch` returns `dispatched=false` and the heartbeat scheduler retries on its next tick — natural serialization without explicit queueing. Lease lifetime mirrors the run lease (`Plan 2 Task 1` writes both); on lease expiry, the workspace lease releases too so a new run can pick it up. **Filestore mode is per-project**, not per-deployment — single-host paperclip and ephemeral-mode projects are unchanged.

**Tech Stack:** No new dependencies. Reuses Plan 2's lease reaper pattern for orphaned workspace leases. New `workspace_leases` table (Drizzle migration). Worker-side: a small helper that resolves a "filestore-mode" `RealizedWorkspace` to the shared path without cloning.

**Scope split (this plan covers Plan 4 of 5):**
- ✅ This plan: opt-in filestore mode per project; `workspace_leases` table; lease acquire / renew / release + reaper; worker-side path-only realization branch; dispatch serialization.
- ⏭ Plan 5: GCP-native polish — autoscaler custom metric, GCS-backed session/artifact store, Cloud Monitoring dashboards, admin `/_workers` UI, **cross-VM port exposure for UI-triggered service preview**, **cross-worker runtime service reuse** (filestore unlocks the workspace half; the service-host design lives here).

**Explicitly NOT in this plan** (continues Plans 1-3 scope):
- Migrating remaining `*_local` adapters to the worker.
- Multiple concurrent readers on the same workspace (read-lock vs write-lock semantics) — v4 uses single exclusive lock per workspace; if products need concurrent reads, we layer that on later.
- Cross-region filestore replication / read replicas.
- Live migration from ephemeral to filestore mode (toggling the flag mid-flight) — opt-in only at project-create / project-edit time when the workspace is idle.

---

## File Structure

**Created:**
- `packages/db/src/schema/workspace_leases.ts` — new table.
- `packages/db/src/migrations/0083_workspace_leases.sql` — DDL.
- `server/src/services/workspace-lease-store.ts` — acquire / renew / release primitives backed by Drizzle.
- `server/src/services/__tests__/workspace-lease-store.test.ts`
- `server/src/services/workspace-lease-reaper.ts` — periodic sweep that releases expired leases (analogous to `lease-reaper.ts` from Plan 2).
- `server/src/services/__tests__/workspace-lease-reaper.test.ts`
- `packages/worker/src/workspace-filestore.ts` — `realizeFilestoreWorkspace` companion to `workspace.ts`'s ephemeral realization.
- `packages/worker/src/__tests__/workspace-filestore.test.ts`

**Modified:**
- `packages/db/src/schema/project_workspaces.ts` — add `filestore_mode` (text, "off" | "on") column. Defaults to "off" so every existing row stays unchanged. The existing `sharedWorkspaceKey` column already hints at multi-run reuse; filestore_mode upgrades that from "same key" to "same path on disk".
- `packages/db/src/schema/index.ts` — export `workspaceLeases`.
- `server/src/adapters/dispatch-or-local.ts` — before `tryDispatch`, if the workspace is filestore-mode, acquire a workspace lease via the store. If the lease is taken, return early (the seam falls back to local execution OR returns `dispatched=false` so the scheduler retries — caller policy).
- `server/src/services/run-dispatcher.ts` — `DispatchInput` gains optional `filestoreWorkspacePath?: string`; when set, it's threaded into the proto's `RunDispatch.execution_workspace_json` so the worker's `realizeWorkspace` knows to take the path-only branch.
- `packages/worker/src/run-handler.ts` — when `executionWorkspaceJson` includes `filestoreMode: "on"` + `filestorePath`, call `realizeFilestoreWorkspace` instead of the ephemeral one. Cleanup is a no-op (we don't delete a shared path).
- `server/src/index.ts` — start the workspace-lease reaper alongside the existing run-lease reaper from Plan 2 Task 2.
- `server/src/config.ts` — add `PAPERCLIP_FILESTORE_ROOT` env. Required only when any project actually uses filestore mode; absent means "filestore mode is unavailable on this deployment", and any project that opts in fails dispatch with a clear error.

**Migration:** `0083_workspace_leases.sql` — new table + new column on `project_workspaces`.

---

## Conventions used in this plan

Same as Plans 1-3:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL alongside the schema change.
- **Commit style:** conventional commits — `feat(server): ...`, `feat(worker): ...`, `feat(db): ...`. Co-author: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch** off the previous task's branch. TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: Schema — `workspace_leases` table + `filestore_mode` column

**Files:**
- Create: `packages/db/src/schema/workspace_leases.ts`
- Modify: `packages/db/src/schema/project_workspaces.ts` — add `filestoreMode` column
- Modify: `packages/db/src/schema/index.ts` — re-export `workspaceLeases`
- Generate: `packages/db/src/migrations/0083_workspace_leases.sql`

```ts
// workspace_leases shape:
//   id (uuid, pk)
//   project_workspace_id (uuid, fk → project_workspaces.id, ON DELETE CASCADE)
//   held_by_run_id (uuid, fk → heartbeat_runs.id, ON DELETE SET NULL)
//   held_by_worker_id (text, nullable)
//   acquired_at (timestamptz NOT NULL DEFAULT now())
//   expires_at (timestamptz NOT NULL)
//   released_at (timestamptz, nullable — NULL means still held)
//   UNIQUE(project_workspace_id) WHERE released_at IS NULL
//     (one active lease per workspace; the partial unique index is the
//     concurrency-correctness oracle)
```

The partial-unique constraint is the actual lock — Postgres rejects a second insert into the same workspace if the prior row's `released_at` is null. We rely on this rather than table-level locking; that keeps acquire under 1ms even under contention.

- [ ] **Step 1: Edit schemas + run `pnpm --filter @paperclipai/db generate`.**
- [ ] **Step 2: Sanity-check the migration SQL** — partial unique index syntax is the only thing that's drizzle-kit-fragile. If drizzle-kit can't emit `WHERE released_at IS NULL` directly, hand-edit the SQL file (precedent: Plan 1 Task 2 had a similar manual edit).
- [ ] **Step 3: Whole-repo typecheck.**
- [ ] **Step 4: Commit + push.**

---

## Task 2: `workspace-lease-store` — acquire / renew / release

**Files:**
- Create: `server/src/services/workspace-lease-store.ts`
- Create: `server/src/services/__tests__/workspace-lease-store.test.ts`

Three primitives over the table:
- `acquire({ projectWorkspaceId, runId, workerId, leaseSeconds }) → { acquired: true, leaseId } | { acquired: false, currentHolderRunId }`
  - Insert with the partial unique constraint as the gate. On unique violation, look up the current holder and return it.
- `renew({ leaseId, leaseSeconds }) → boolean` — bump `expires_at`. Returns false if the lease was released or expired.
- `release({ leaseId })` — set `released_at = now()`. Idempotent.

- [ ] **Step 1: Write failing tests** (use a real in-memory pglite or hosted test DB — the precedent in this repo is pglite via `@paperclipai/db` test helpers).
  - Acquire on free workspace → `{acquired: true}`.
  - Acquire on busy workspace → `{acquired: false, currentHolderRunId: "..."}`.
  - Acquire after release → `{acquired: true}` (different leaseId).
  - Renew non-existent lease → false.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — the unique-constraint-violation translation is the subtle part: drizzle-orm surfaces it as a Postgres error code 23505, parsing that to "busy" instead of throwing keeps acquire's contract clean.
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 3: Workspace-lease reaper

**Files:**
- Create: `server/src/services/workspace-lease-reaper.ts`
- Create: `server/src/services/__tests__/workspace-lease-reaper.test.ts`

Pure function over `(now, findExpired, settle)` exactly like Plan 2's run-lease reaper. Settles by setting `released_at = now()` on rows whose `expires_at < now() AND released_at IS NULL`.

Production wire: 30s setInterval next to the run-lease reaper in `server/src/index.ts`. Failed sweeps log; per-row settle errors are absorbed (next cycle re-includes).

- [ ] **Step 1: Write failing test** (mirrors lease-reaper.test.ts shape).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 4: Server-side dispatch wiring — acquire lease before tryDispatch

**Files:**
- Modify: `server/src/adapters/dispatch-or-local.ts` — wrap `tryDispatch` with lease acquire/release on the filestore-mode path.
- Modify: `server/src/adapters/__tests__/dispatch-or-local.test.ts` — add a test for the filestore branch.

Logic:
1. Read `project_workspaces.filestore_mode` for the run's workspace. (Workspace id flows through `executionWorkspace` already.)
2. If `off`: existing path unchanged (ephemeral, per-worker clone).
3. If `on`:
   a. Verify `PAPERCLIP_FILESTORE_ROOT` is set; if not, return `dispatched=false` with reason `"filestore_root_unconfigured"`.
   b. Try to acquire workspace lease.
   c. If unavailable: return `dispatched=false` with reason `"workspace_busy"`. The heartbeat scheduler's existing retry-on-next-tick handles serialization naturally — no explicit queue.
   d. On `tryDispatch` send-success: pass `leaseId` into the awaitCompletion `finally` so the lease releases when the run settles.
   e. On dispatch send-failure: release the lease immediately (rollback).

The seam stays simple — no explicit "wait for lease" loop here.

- [ ] **Step 1: Write failing tests:**
  - Filestore-mode workspace, lease available → dispatch succeeds, lease acquired with the run id.
  - Filestore-mode workspace, lease busy → dispatch returns `dispatched=false, reason="workspace_busy"`.
  - Run completes → lease released.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 5: Worker-side path-only realization

**Files:**
- Create: `packages/worker/src/workspace-filestore.ts`
- Create: `packages/worker/src/__tests__/workspace-filestore.test.ts`
- Modify: `packages/worker/src/run-handler.ts` — branch on `filestoreMode` in the workspace descriptor.
- Modify: `packages/worker/src/index.ts` — pass the filestore root from env into the realization path.

`realizeFilestoreWorkspace({ filestoreRoot, sharedWorkspaceKey }) → { cwd, cleanup }`:
- `cwd = path.join(filestoreRoot, sharedWorkspaceKey)`
- `cleanup = async () => {}` — never delete a shared path; the workspace persists across runs.
- Throws if `filestoreRoot` doesn't exist on disk (loud failure beats silent stale-data).

The `executionWorkspace` JSON descriptor that flows on the wire is extended (server side) to carry `{ filestoreMode: "on", sharedWorkspaceKey: "..." }` for filestore-mode projects, and the existing fields for ephemeral.

- [ ] **Step 1: Write failing tests** for the helper — happy path + missing-root error.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement helper + branch in run-handler.**
- [ ] **Step 4: GREEN, typecheck, commit + push.**

---

## Task 6: Per-project opt-in API

**Files:**
- Modify: `server/src/routes/project-workspaces.ts` (or wherever workspace creation/edit lives) — accept `filestoreMode: "off" | "on"`.
- Modify: `server/src/routes/__tests__/...` — assert the column reads/writes correctly via the API.
- Modify: UI (`ui/src/...`) — add a toggle on the workspace settings panel. **Out of scope if the route already validates the flag and a power user can flip it via API/CLI.**

The flag is enforced at dispatch time (Task 4); this task is just the data plumbing so users can actually set it.

- [ ] **Step 1: Find the existing project-workspace route.** If filestore mode needs API-level guarding (e.g., reject toggling while a run is in flight on the workspace), include that check.
- [ ] **Step 2: Tests + implement.**
- [ ] **Step 3: GREEN, typecheck, commit + push.**

---

## Task 7: E2E test — two sequential runs share workspace

**Files:**
- Modify: `server/src/__tests__/distributed/end-to-end.test.ts` — add a third case.

Spec the e2e:
1. Spin up gRPC server + a real worker client.
2. Create a filestore-mode project workspace (use a temp dir as `PAPERCLIP_FILESTORE_ROOT`).
3. Dispatch run A with `filestoreWorkspacePath`; assert the worker received a path-only realization (no clone).
4. Before run A completes, attempt run B on the same workspace; assert `dispatched=false, reason="workspace_busy"`.
5. Complete run A; assert lease releases.
6. Re-dispatch run B; assert it now succeeds with the same path.

This is the integration cousin of the unit tests in Tasks 2 + 4.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: GREEN. Commit + push.**

---

## Task 8: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1:** `pnpm -r build` and `pnpm --filter '!@paperclipai/server' -r test` — green.
- [ ] **Step 2:** Targeted server: `pnpm --filter @paperclipai/server exec vitest run src/services/__tests__/ src/worker-rpc/__tests__/ src/__tests__/distributed/ src/adapters/__tests__/`. All pass.
- [ ] **Step 3:** Update `ROADMAP.md` Cloud / Sandbox agents bullet to mention filestore mode landed.
- [ ] **Step 4:** Commit + push.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** spec phase 6 ("Filestore mode + lease coordination — opt-in workspace flag, lease table, dispatcher integration") is exercised by the schema, lease store, dispatch wiring, worker-side realization, and reaper.
- [ ] **No placeholders:** zero hits for "TBD", "TODO", "implement later".
- [ ] **Type consistency:** `project_workspace_id` / `projectWorkspaceId` consistent across schema, store, dispatch, worker.
- [ ] **Commit hygiene:** every task ends green (`pnpm -r build && targeted tests`).
- [ ] **No new adapters added.** `claude_local` and `gemini_local` remain the only adapters wired through the dispatch-or-local seam.
- [ ] **Backwards compatibility.** Existing projects (filestore_mode = "off") behave exactly as Phase 1-3. Filestore mode is opt-in.

## What's not done after this plan

- **Cross-worker runtime service reuse.** Plan 3 deferred this with the rationale "filestore unlocks the workspace half; service reuse needs network-addressable services". With filestore landed, that follow-up is now feasible — services on a shared workspace become discoverable across workers via the workspace path. Designing the service-host topology lives in Plan 5.
- **Read-lock semantics.** Two read-only runs on the same workspace today serialize. If the product needs concurrent reads (e.g., status agents that don't write), add `lock_kind = 'read' | 'write'` to the leases table and adjust the partial unique to allow multiple readers.
- **Cross-region / cross-zone filestore replication.** v1 assumes a single mount visible from every worker.
- **Live mode toggle.** Switching a project from ephemeral → filestore (or vice versa) while runs are in flight is rejected. Toggle requires the workspace to be idle.
- **GCP-native polish** — autoscaler custom metric, GCS session store, Cloud Monitoring dashboards, admin `/_workers` UI, cross-VM port exposure for UI service preview, cross-worker service reuse. Plan 5.
- **Remaining `*_local` adapters.** Excluded at user request — they stay on the in-process fall-back path.
