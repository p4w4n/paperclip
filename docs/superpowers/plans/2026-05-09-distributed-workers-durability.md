# Distributed Workers Durability Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the foundation shipped in Plan 1 (`2026-05-08-distributed-workers-foundation.md`) and make it survive real failures — control-plane restart mid-run, worker death mid-run, network drops, and rolling MIG updates — without dropping or double-executing runs. The dispatch path stays unchanged for `claude_local` and `gemini_local` (the two adapters wired through the dispatch-or-local seam in Plan 1); no new adapters are added in this plan.

**Architecture:** Plan 1's `RunDispatcher.leaseTimers` map is in-memory only — server restart loses every timer. This plan persists `lease_expires_at` and `dispatched_to_worker_id` to `heartbeat_runs` (columns already added in Plan 1's migration `0082_distributed_workers.sql`), then runs a periodic **lease reaper** that scans for expired in-flight runs and settles them. On lease expiry the run is **idempotently re-dispatched** by incrementing the existing `attempts` column (spec NOTE N8 — "replay_count increments only on lease-expiry-driven auto-replay") and re-queuing through the heartbeat scheduler; late `RunComplete` frames from the dead worker are dropped by checking the run's current `dispatched_to_worker_id` against the sender. The worker binary gains an exponential-backoff reconnect loop (replaces the current "stream EOF kills the process" model) and accepts a server-pushed `DrainRequested` frame so MIG rolling updates finish in-flight runs cleanly before the instance shuts down.

**Tech Stack:** No new dependencies. Reuses Plan 1's `@grpc/grpc-js`, Drizzle, Vitest. The reaper job follows the existing `setInterval`-on-startup pattern that drives `heartbeatScheduler` (server/src/services/heartbeat.ts).

**Scope split (this plan covers Plan 2 of 5):**
- ✅ This plan: durable lease (DB-backed `lease_expires_at`), lease reaper, idempotent re-dispatch on lease expiry, late-completion drop, worker reconnect with exponential backoff, MIG drain handling
- ⏭ Plan 3: workspace runtime services (`workspace-runtime.ts`) on the worker
- ⏭ Plan 4: filestore opt-in mode + lease coordination
- ⏭ Plan 5: GCP-native polish (autoscaler custom metric, GCS session store, Cloud Monitoring dashboards, admin `/_workers` UI)

**Explicitly NOT in this plan** (deferred at user request — Plan 1 swap from `pi_local` to `claude_local`+`gemini_local` carried through):
- Migrating `codex_local`, `cursor`, `opencode_local`, `acpx_local`, `openclaw_gateway`, `pi_local` adapters to the worker. Those each get a `createDispatchOrLocal` wrapper in a follow-up plan when the team needs them.

---

## File Structure

**Created:**
- `server/src/services/lease-reaper.ts` — periodic scan + settle expired leases
- `server/src/services/__tests__/lease-reaper.test.ts`
- `packages/worker/src/reconnect.ts` — backoff state machine wrapping `startWorkerClient`
- `packages/worker/src/__tests__/reconnect.test.ts`

**Modified:**
- `server/src/services/run-dispatcher.ts` — accept a `db` for durable lease writes; persist on dispatch / extension; clear on `markCompleted`. The in-memory `setTimeout` stays as the fast-path fire trigger; the DB row is the recovery oracle after a restart.
- `server/src/worker-rpc/connect-handler.ts` — on `RunComplete`/`RunFailed`, validate the sender's `workerId` against `heartbeat_runs.dispatched_to_worker_id` before settling; mismatch → log + drop (spec failure-mode "duplicate run dispatch — first RunComplete wins, second dropped").
- `server/src/index.ts` — start `lease-reaper` interval after the gRPC server boots; stop it on SIGTERM.
- `server/src/services/heartbeat.ts` — when a run settles with `error_code = "lease_expired"` and `attempts < maxAttempts`, mark it back to `queued` instead of `failed` so the existing scheduler tick re-dispatches.
- `packages/worker/src/index.ts` — replace the single `startWorkerClient` call with a `connectWithBackoff` loop from the new `reconnect.ts`. Stream EOF triggers reconnect, not process exit.
- `packages/worker/src/client.ts` — surface a `disconnect` event (Promise that resolves on stream end) so `reconnect.ts` knows when to back off + retry. Also wires the `DrainRequested` server frame into the dispatch handler.

**Migration:** None. The columns this plan needs (`lease_expires_at`, `attempts`, `dispatched_to_worker_id`) all landed in `0082_distributed_workers.sql` during Plan 1.

---

## Conventions used in this plan

Same as Plan 1:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Commit style:** conventional commits — `feat(server): ...`, `feat(worker): ...`, `test(server): ...`. Co-author: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch** off the previous task's branch. TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.
- **No placeholder commits.** Every commit ends green.

---

## Task 1: Persist lease deadline to `heartbeat_runs`

**Files:**
- Modify: `server/src/services/run-dispatcher.ts`
- Modify: `server/src/services/__tests__/run-dispatcher-lease.test.ts`

**Why:** today `armLease` only writes to in-memory maps. After a control-plane restart there's no record of which runs are mid-flight or when their leases expire. The reaper in Task 2 needs `heartbeat_runs.lease_expires_at` and `dispatched_to_worker_id` to find recoverable work.

- [ ] **Step 1: Write the failing test**

In `run-dispatcher-lease.test.ts`, add a case that asserts `tryDispatch` writes `lease_expires_at` and `dispatched_to_worker_id` to a stub DB. The dispatcher accepts an optional `persistLease` callback so tests don't need a real Drizzle handle:

```ts
it("persists lease deadline + dispatched worker on dispatch", async () => {
  registry.register(makeWorker());
  const persistLease = vi.fn(async () => {});
  const dispatcher = new RunDispatcher(registry, { persistLease });
  await dispatcher.tryDispatch({
    runId: "r-persist", agentId: "a", adapterType: "claude_local",
    adapterConfig: {}, executionWorkspace: {}, secretsScopeToken: "tok", leaseSeconds: 60,
  });
  expect(persistLease).toHaveBeenCalledWith({
    runId: "r-persist",
    workerId: "w",
    leaseExpiresAt: expect.any(Date),
  });
});
```

Also add: `markCompleted` calls `persistLease({ runId, workerId: null, leaseExpiresAt: null })` so the reaper doesn't pick up already-settled rows.

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement**

`RunDispatcher` constructor takes a second optional opts arg `{ persistLease?: (input) => Promise<void> }`. Default is a no-op so existing tests are unchanged. `tryDispatch` calls it after the bidi send succeeds (lease window starts when the worker actually has the dispatch); `markCompleted` calls it with nulls.

Production wiring (one-liner in `server/src/index.ts` next to where `runDispatcher` is consumed) provides the real Drizzle update against `heartbeat_runs`.

- [ ] **Step 4: GREEN, typecheck, commit**

```
git add server/src/services/run-dispatcher.ts server/src/services/__tests__/run-dispatcher-lease.test.ts
git commit -m "$(cat <<'EOF'
feat(server): persist lease deadline + dispatched worker to heartbeat_runs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Lease reaper job

**Files:**
- Create: `server/src/services/lease-reaper.ts`
- Create: `server/src/services/__tests__/lease-reaper.test.ts`
- Modify: `server/src/index.ts`

**Why:** the in-memory `setTimeout` from Plan 1 only fires while the server process is alive. A control-plane restart while a run is dispatched → the timer is gone, the run hangs in `running` forever. The reaper is the recovery oracle: every 30s it scans for `state=running AND lease_expires_at < now()` and settles.

- [ ] **Step 1: Write the failing test**

Spec the reaper as a pure function over a `Date.now()` clock + a `findExpired` callback + a `settle` callback so tests don't need DB or timers:

```ts
it("settles expired runs with lease_expired", async () => {
  const settle = vi.fn();
  await reapExpiredLeases({
    now: () => new Date("2026-05-09T00:00:00Z"),
    findExpired: async () => [{ runId: "r1", workerId: "w-dead", leaseExpiresAt: new Date("2026-05-08T23:59:00Z") }],
    settle,
  });
  expect(settle).toHaveBeenCalledWith({ runId: "r1", reason: "lease_expired" });
});

it("doesn't settle runs whose lease is still in the future", async () => { /* ... */ });
```

- [ ] **Step 2: Implement** `reapExpiredLeases({ now, findExpired, settle })` — single async function, no class needed.

- [ ] **Step 3: Wire** in `server/src/index.ts`: after the gRPC server starts, `setInterval(() => reapExpiredLeases({ ... }), 30_000)`. The `settle` callback fans into both `runDispatcher.notifySettlement(runId, { kind: "lease_expired" })` and the existing `settleRunCompletion(runId, new Error("lease_expired"))`.

- [ ] **Step 4: GREEN, typecheck, commit**

---

## Task 3: Idempotent re-dispatch on lease expiry

**Files:**
- Modify: `server/src/services/heartbeat.ts` — handle `error_code = "lease_expired"` specially
- Create: `server/src/services/__tests__/lease-replay.test.ts`

**Why:** today a `lease_expired` settlement marks the run failed and stops. Per spec NOTE N8, lease-expiry-driven failures should auto-replay (increment `attempts`, transition the run back to `queued`) up to a configurable max. User-initiated retries continue to use the existing `retry_of_run_id` path — separate code path, separate semantics.

- [ ] **Step 1: Decide max-attempts policy**

Spec doesn't pin a number. Default to **2 attempts total** (1 retry after lease expiry) for v1: enough to cover a single worker death, but capped low so a poison run doesn't burn worker capacity in a loop. Configurable via `WORKER_LEASE_MAX_ATTEMPTS` env (default 2).

- [ ] **Step 2: Write the failing test**

A run that expires once gets re-queued; a run that expires after `attempts >= max` gets marked failed for real:

```ts
it("re-queues run after first lease expiry, fails after max attempts", async () => {
  await heartbeatService.handleLeaseExpiry({ runId: "r1", currentAttempts: 0, max: 2 });
  expect(runState("r1")).toEqual({ state: "queued", attempts: 1 });
  await heartbeatService.handleLeaseExpiry({ runId: "r1", currentAttempts: 1, max: 2 });
  expect(runState("r1")).toEqual({ state: "failed", attempts: 2, errorCode: "lease_expired_terminal" });
});
```

- [ ] **Step 3: Implement** `handleLeaseExpiry` on the heartbeat service. The reaper's `settle` callback (Task 2) calls into this. The existing scheduler tick will pick up `state=queued` runs and dispatch them through the same `claude_local` / `gemini_local` adapter path.

- [ ] **Step 4: GREEN, typecheck, commit**

---

## Task 4: Drop late completions from re-dispatched runs

**Files:**
- Modify: `server/src/worker-rpc/connect-handler.ts`
- Modify: `server/src/worker-rpc/__tests__/connect-handler.test.ts`

**Why:** after Task 3, run `r1` can be dispatched to worker-1, lease-expire, get re-queued, then dispatched to worker-2. If worker-1 was just slow (not dead) and finally sends `RunComplete` for `r1`, the connect-handler currently calls `settleRunCompletion("r1", ...)` which would resolve worker-2's pending awaiter with the wrong result. Spec failure-mode "duplicate run dispatch — first `RunComplete` wins, second dropped (logged)" maps to: drop the frame if the sender's `workerId` doesn't match the row's current `dispatched_to_worker_id`.

- [ ] **Step 1: Write the failing test**

Drive a fake bidi stream where worker-1 sends `RunComplete` for a runId whose `dispatched_to_worker_id` has already moved to worker-2; assert the awaiter doesn't fire and a "stale completion dropped" log line is emitted.

- [ ] **Step 2: Implement** the gate. Pass a `getCurrentDispatchedWorker(runId): Promise<string | null>` callback into `handleConnect` opts (production wires it to a Drizzle select; tests stub it). On `RunComplete` / `RunFailed`, look up first; if it's null or doesn't match the sender, log + drop without settling.

- [ ] **Step 3: GREEN, typecheck, commit**

---

## Task 5: Worker reconnect with exponential backoff

**Files:**
- Create: `packages/worker/src/reconnect.ts`
- Create: `packages/worker/src/__tests__/reconnect.test.ts`
- Modify: `packages/worker/src/client.ts` — expose a `disconnect` event
- Modify: `packages/worker/src/index.ts` — wrap `startWorkerClient` in the new loop

**Why:** today the worker `index.ts` calls `startWorkerClient` once and `await new Promise(() => {})` to hold the process open. If the gRPC stream drops (server restart, network blip, idle timeout), the worker stays "up" with a dead stream; in production the MIG instance autohealing eventually replaces it, but that's seconds of unnecessary downtime. Reconnect loop: on stream end, back off exponentially (1s → 2s → 4s → … → cap at 30s) and re-call `startWorkerClient`. The same `workerId` is used (spec NOTE N1: server evicts the prior session on duplicate Hello).

- [ ] **Step 1: Surface stream end on the client**

`startWorkerClient` returns a handle. Add a `closed: Promise<void>` field that resolves when `call.on("end" | "close" | "error")` fires.

- [ ] **Step 2: Write the failing test for `connectWithBackoff`**

The function takes `{ start: () => Promise<{ closed: Promise<void> }>, sleep, maxBackoffMs, signal }`. With `signal` aborted, it stops. Without abort, after `closed` resolves, it sleeps `attempt * 1000` (capped) and re-invokes `start`.

- [ ] **Step 3: Implement** + wire into `index.ts`. Process exit only on SIGTERM / unrecoverable auth failure (not on stream drop).

- [ ] **Step 4: GREEN, typecheck, commit**

---

## Task 6: Worker accepts `DrainRequested`

**Files:**
- Modify: `packages/worker/src/client.ts` — handle the `drainRequested` server frame
- Modify: `packages/worker/src/index.ts` — set `draining=true` flag, don't accept new dispatches, send `Bye` after the last in-flight run completes
- Modify: `server/src/worker-rpc/connect-handler.ts` — already excludes draining workers from `pickFor` (Task 4 from Plan 1); double-check the wire hook for emitting `DrainRequested` server-side
- Create: `packages/worker/src/__tests__/drain.test.ts`

**Why:** GCE MIG rolling updates send SIGTERM to outgoing instances. We want them to finish their in-flight run before exiting (spec failure-mode "MIG rolling update — `Drain` frame to outgoing instances; they finish in-flight, send `Bye`, disconnect; no run loss"). v1 of the drain pathway only needs the worker side: server sends `DrainRequested` on shutdown handler (or admin RPC — out of scope, can be triggered by SIGTERM relay), worker gracefully winds down.

- [ ] **Step 1: Spec the drain protocol on the worker**

When `DrainRequested` arrives:
1. Set a process-local `draining = true` flag.
2. Stop accepting new dispatches: if `onDispatch` fires while draining, immediately respond with `RunFailed { errorCode: "worker_draining" }` so the dispatcher's `tryDispatch` returns false and the run falls back to local execution.
3. When in-flight count drops to zero, send `Bye` and end the stream.
4. Process exits 0 after `Bye`.

- [ ] **Step 2: Write the failing test** for the in-process state machine.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: GREEN, typecheck, commit**

Note: the server-side trigger for `DrainRequested` (an admin endpoint or SIGTERM-relay-to-workers) is **out of scope** for this plan. The worker-side handling is what survives MIG drains. Server-side opt-in trigger is a follow-up.

---

## Task 7: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1:** `pnpm -r build` and `pnpm --filter '!@paperclipai/server' -r test` — green.
- [ ] **Step 2:** Run targeted server tests: `pnpm --filter @paperclipai/server exec vitest run src/services/__tests__/ src/worker-rpc/__tests__/ src/__tests__/distributed/`. Confirm all pass.
- [ ] **Step 3:** `ROADMAP.md` — update the Cloud / Sandbox agents bullet to mention durability landed (lease reaper, idempotent re-dispatch, reconnect, drain).
- [ ] **Step 4:** Commit + push.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** every spec section for lease + reaper + reconnect + drain is exercised: durable lease (D6, NOTE N2), reaper (Lease + reaper section), idempotent re-dispatch (NOTE N8 + failure-mode duplicate run dispatch), worker reconnect (failure-mode worker crashes / network partition), MIG drain (failure-mode MIG rolling update — worker side only).
- [ ] **No placeholder strings:** zero hits for "TBD", "TODO", "implement later".
- [ ] **Type consistency:** `lease_expired` error_code spelled the same in heartbeat service, reaper, and connect-handler.
- [ ] **Commit hygiene:** every task ends green (`pnpm -r build && targeted tests`).
- [ ] **No new adapters added.** `claude_local` and `gemini_local` remain the only adapters wired through the dispatch-or-local seam — out-of-scope adapters stay in-process via the fall-back path.

## What's not done after this plan

- **Server-side drain trigger.** Worker handles `DrainRequested` cleanly (Task 6); the server-side admin endpoint or SIGTERM-relay that emits the frame is queued. Until then, MIG drain depends on graceful SIGTERM handling at the worker process level (the reaper reaps anything that doesn't finish in time, so this isn't a correctness gap, just a "no-runs-lost-on-rolling-update" gap).
- **Workspace runtime services on worker.** Plan 3.
- **Filestore opt-in mode.** Plan 4.
- **GCP-native polish** — autoscaler custom metric (excludes draining workers per spec D3), GCS-backed session/artifact store, Cloud Monitoring dashboards, admin `/_workers` UI. Plan 5.
- **Remaining `*_local` adapters** (`codex_local`, `cursor`, `opencode_local`, `acpx_local`, `openclaw_gateway`, `pi_local`). Excluded at user request — they stay on the in-process fall-back path.
