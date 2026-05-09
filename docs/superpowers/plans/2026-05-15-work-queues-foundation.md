# Work Queues Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-13-work-queues-design.md`. This plan delivers: `work_items` + `work_queue_tenant_credits` tables with the partial-unique dedupe primitive, the `WorkQueueService` write/dequeue path (SKIP LOCKED, weighted round-robin), materialization into `heartbeat_runs`, the failure classifier + per-routine retry policy, dead-letter handling, routine integration via the `enqueue_via_work_queue` flag, the webhook ingestion endpoint with idempotency-key dedup, OTel messaging semconv (Stable 2026), the admin UI page with depth + DLQ + replay, and a plugin-SDK helper.

**Architecture:** New `server/src/services/work-queue/` module owns the contract + default Postgres-native implementation. The dequeue step extends the existing `heartbeatScheduler.ts` 30-second tick with a weighted round-robin draw across companies; per-company SKIP LOCKED queries pull priority-ordered items inside that loop. Materialization inserts a `heartbeat_runs` row and the existing dispatcher (Plan 1 of distributed-workers) takes over from there. The failure classifier reads the run's terminal `error_code` and routes back to retry / dead-letter via the per-routine `retry_policy` JSONB.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres), `pg-boss`-style SKIP LOCKED dequeue (no Redis), OpenTelemetry SDK + messaging semconv.

**Scope split (this plan covers Plan 1 of 2 for work queues):**

- ✅ This plan: schema + enqueue / dequeue primitives; weighted round-robin scheduler; materialization into runs; failure classification + retry; dead-letter; routine integration; webhook ingestion; OTel messaging semconv; admin UI; plugin-SDK enqueue helper.
- ⏭ Plan 2: per-queue concurrency caps; per-company DLQ size caps with auto-archival; streaming-source plugins (Kafka / pubsub); deadline-aware scheduling; cross-region replication; per-tenant enqueue rate-limits at the API surface; bulk replay endpoints; cron-on-queue timing knobs beyond the 30s heartbeat tick.

---

## File Structure

**Created:**

- `packages/db/src/schema/work_items.ts` — Drizzle schema for the queue table.
- `packages/db/src/schema/work_queue_tenant_credits.ts` — Drizzle schema for the fairness counter.
- `packages/db/src/migrations/0087_work_queues_foundation.sql` — DDL with the partial-unique dedupe + the dequeue index. Hand-edit the partial-WHERE indexes (drizzle-kit doesn't emit them).
- `server/src/services/work-queue/types.ts` — `WorkQueueService` contract; `EnqueueInput` / `EnqueueResult` / `WorkItem` shapes; `WorkQueueTenantMismatchError`.
- `server/src/services/work-queue/service.ts` — in-process service: enqueue / dequeueBatch / cancel / replay / list with tenant gate.
- `server/src/services/work-queue/dequeue.ts` — pure-ish helper running the SKIP LOCKED query inside a per-company loop.
- `server/src/services/work-queue/fairness.ts` — pure: given `weight[]` + `recent_dequeued[]`, returns the company draw order.
- `server/src/services/work-queue/classify-failure.ts` — pure mapping `(error_code, error_message) → retry_class`.
- `server/src/services/work-queue/retry-policy.ts` — pure: applies the per-routine `retry_policy` to a `retry_class`, returns a `RetryDecision` (`retry_at` | `dead_letter` | `discard`).
- `server/src/services/work-queue/scheduler.ts` — production wire that extends the heartbeat 30s tick with a `runWorkQueueDrain(maxItems)` step.
- `server/src/services/work-queue/poke.ts` — `pokeScheduler(companyId)` for low-latency wake on webhook ingest.
- `server/src/services/work-queue/metrics.ts` — OTel counters / histograms / gauges.
- `server/src/services/work-queue/spans.ts` — OTel messaging-semconv span helpers.
- `server/src/services/work-queue/__tests__/*.test.ts` — one per module.
- `server/src/routes/work-queue.ts` — `POST /api/companies/:companyId/work-queue/:queue/items`; admin endpoints `GET /admin/work-queue/depth`, `GET /admin/work-queue/dead-letter`, `POST /admin/work-queue/replay/:itemId`.
- `ui/src/pages/AdminWorkQueue.tsx` — admin page with depth panel, dead-letter inspector, replay one button.
- `packages/plugin-sdk/src/work-queue.ts` — SDK wrapper exposing `workQueue.enqueue()` to plugin authors (export it via the plugin-sdk barrel).

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `workItems`, `workQueueTenantCredits`.
- `packages/db/src/schema/routines.ts` — add `enqueue_via_work_queue BOOLEAN NOT NULL DEFAULT false` and `default_retry_policy JSONB` columns; migration in 0087.
- `server/src/services/heartbeat.ts` — extend the 30s tick to call `runWorkQueueDrain` before the existing dispatch loop; on run-completion, observe the `work_item.run_id` and update the work item's terminal state.
- `server/src/services/routines.ts` — when `enqueue_via_work_queue` is true, fire-event creates a `work_item` instead of an issue/run; the dequeue step calls back into `routine.materialize()`.
- `server/src/index.ts` — register the new admin routes.
- `server/src/api-router.ts` — register the new public + admin routes.
- `ui/src/App.tsx` — add the `/admin/work-queue` route.

**Migration:** `0087_work_queues_foundation.sql`. Adds both tables + the partial unique on `(company_id, dedupe_key) WHERE state IN ('queued','running')` + the dequeue index `(company_id, queue, priority DESC, available_at) WHERE state = 'queued'` + the dead-letter index. Adds the two routine columns. All hand-edited per drizzle-kit's partial-WHERE limitation (precedent: 0083, 0084, 0085).

---

## Conventions used in this plan

Same as the memory + artifacts plans:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL file alongside the schema change. Hand-edit when drizzle-kit's emit is wrong.
- **Commit style:** conventional `feat(db): …`, `feat(server): …`, `feat(ui): …`. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: schema + migration

**Files:**

- Create: `packages/db/src/schema/work_items.ts`
- Create: `packages/db/src/schema/work_queue_tenant_credits.ts`
- Create: `packages/db/src/migrations/0087_work_queues_foundation.sql` (drizzle-kit generate, then hand-edit name + partial indexes + the routines.* additions).
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/schema/routines.ts`, `packages/db/src/migrations/meta/_journal.json`.

`work_items` per the spec's DDL. Hand-edited:
- `work_items_dedupe_active_uniq` partial unique on `(company_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running')`.
- `work_items_dequeue_idx` btree on `(company_id, queue, priority DESC, available_at)` partial WHERE `state = 'queued'`.
- `work_items_dead_letter_idx` partial WHERE `state = 'dead_letter'`.

`work_queue_tenant_credits` per spec.

`routines` gains `enqueue_via_work_queue BOOLEAN NOT NULL DEFAULT false` and `default_retry_policy JSONB`.

Verify: `pnpm --filter @paperclipai/db test src/client.test.ts`.

## Task 2: WorkQueueService contract (types)

**Files:**

- Create: `server/src/services/work-queue/types.ts`
- Create: `server/src/services/work-queue/__tests__/types.test.ts`

Mirrors the spec's TypeScript interfaces: `EnqueueInput`, `EnqueueResult`, `WorkItem`, `WorkQueueServiceContext` (`callerCompanyId`), `WorkQueueTenantMismatchError`, `RetryClass`, `RetryDecision`, `WorkItemState` ('queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled').

## Task 3: enqueue() with dedupe

**Files:**

- Create: `server/src/services/work-queue/service.ts` (initial — only declares enqueue + skeletons for the others).
- Create: `server/src/services/work-queue/__tests__/service-enqueue.test.ts`

`enqueue(ctx, input)`: assertTenant, validate `priority ∈ [0,9]`, default `queue='default'`, default `state='queued'`, default `available_at=now()`. INSERT … ON CONFLICT (the partial unique handles the dedupe race). On dedupe conflict: `SELECT id WHERE company_id=$1 AND dedupe_key=$2 AND state IN ('queued','running')` and return `{enqueued: false, reason: 'duplicate', existingId, workItemId: existingId}`.

Tests: tenant mismatch rejected; clean enqueue returns id; dedupe collision returns `{enqueued: false}`; null dedupeKey allowed (no unique constraint applies); priority validation.

## Task 4: dequeue helper

**Files:**

- Create: `server/src/services/work-queue/dequeue.ts`
- Create: `server/src/services/work-queue/__tests__/dequeue.test.ts`

`dequeueOneForCompany(db, { companyId, queue, now }) → WorkItem | null` runs `SELECT … FROM work_items WHERE company_id=$1 AND queue=$2 AND state='queued' AND available_at<=$3 ORDER BY priority DESC, available_at LIMIT 1 FOR UPDATE SKIP LOCKED`. The state transition (to 'running') is the caller's job — this helper just locks + returns. Tests use a mocked Drizzle chain.

## Task 5: weighted round-robin fairness

**Files:**

- Create: `server/src/services/work-queue/fairness.ts`
- Create: `server/src/services/work-queue/__tests__/fairness.test.ts`

Pure function `computeDrawOrder({ weights, recentDequeued }): companyId[]` returning the company-id sequence the dequeue loop should walk this tick. Companies with `credits = weight - recent_dequeued` are sorted desc; ties broken by lowest `recent_dequeued`. Tests: equal weight → round-robin; weight=2 vs weight=1 → 2x as often; deterministic on tie.

## Task 6: materialization into heartbeat_runs

**Files:**

- Create: `server/src/services/work-queue/materialize.ts`
- Create: `server/src/services/work-queue/__tests__/materialize.test.ts`

`materializeWorkItem(tx, { item, agentResolver, issueResolver })`: takes a locked work_item row, inserts a `heartbeat_runs` row using either `(target_issue_id, target_agent_id)` or the routine path (`routine.materialize()` produces the issue+run). Updates `work_items.run_id`, `state='running'`, `started_at=now()`. Increments `work_queue_tenant_credits.recent_dequeued` for that company.

Tests mock the resolvers; verify the run insert payload + the work_item update.

## Task 7: failure classifier

**Files:**

- Create: `server/src/services/work-queue/classify-failure.ts`
- Create: `server/src/services/work-queue/__tests__/classify-failure.test.ts`

Pure: `classifyFailure({ errorCode, errorMessage }) → RetryClass`. Mappings:
- `transient_provider` ← errorCode in {`provider_429`, `provider_503`, `network_timeout`} OR message matches /429|503|timeout|reset/.
- `transient_local` ← errorCode in {`lease_expired`, `worker_drain`, `runtime_service_failed`}.
- `poison` ← errorCode in {`adapter_parse_error`, `schema_validation_failed`, `permanent`}.
- `quota_exceeded` ← errorCode = `budget_blocked`.
- `permanent` ← fallback when nothing else matches AND errorCode ends with `_permanent`.

## Task 8: retry policy

**Files:**

- Create: `server/src/services/work-queue/retry-policy.ts`
- Create: `server/src/services/work-queue/__tests__/retry-policy.test.ts`

Pure: `applyRetryPolicy({ retryClass, attempts, maxAttempts, policy }) → RetryDecision`. Defaults:
- `transient_provider` → exponential backoff `min(2^attempts * 1s, 5min)`; dead-letter at `attempts >= maxAttempts`.
- `transient_local` → immediate retry; same dead-letter cap.
- `poison` → `dead_letter` immediately.
- `quota_exceeded` → `available_at = nextBudgetWindow()`; doesn't count against attempts.
- `permanent` → `dead_letter`.

`policy` JSONB can override per-class: `{"on_429": "backoff_minutes", "on_5xx": "retry_3"}` etc. Tests cover each branch + override application.

## Task 9: dead-letter + replay

**Files:**

- Modify: `server/src/services/work-queue/service.ts` — add `cancel(ctx, id)` and `replayDeadLetter(ctx, id, { resetAttempts? })`.
- Create: `server/src/services/work-queue/__tests__/dead-letter.test.ts`

`cancel`: state='cancelled', `completed_at=now()`. Idempotent on already-terminal rows.
`replayDeadLetter`: must currently be in `dead_letter`, transition back to `queued` with `attempts=0` (default) or preserve attempts (opt-in). Resets `available_at=now()`.

## Task 10: routine integration

**Files:**

- Modify: `server/src/services/routines.ts` — when a routine fires AND `enqueue_via_work_queue=true`, call `workQueueService.enqueue()` with `routine_id` set instead of the existing `materializeRoutineFiring()` path.
- Modify: `server/src/services/work-queue/materialize.ts` — when `routine_id` is set on a dequeued item, call back into `routine.materialize()` to produce the run target.
- Create: `server/src/services/work-queue/__tests__/routine-integration.test.ts`

End-to-end shape: routine fires → enqueue → dequeue → routine.materialize() → heartbeat_runs row.

## Task 11: webhook ingestion endpoint

**Files:**

- Create: `server/src/routes/work-queue.ts`
- Modify: `server/src/app.ts` — register the route.
- Create: `server/src/routes/__tests__/work-queue.test.ts`

`POST /api/companies/:companyId/work-queue/:queue/items` accepts JSON body forwarded as `payload`. Honors `Idempotency-Key` header → maps to `dedupe_key`. Auth via existing API key system; assertCompanyAccess on `:companyId`. Body schema validated via zod. Returns the `EnqueueResult`.

## Task 12: scheduler integration

**Files:**

- Create: `server/src/services/work-queue/scheduler.ts` (the `runWorkQueueDrain(opts)` entry point + production wire).
- Modify: `server/src/services/heartbeat.ts` — call `runWorkQueueDrain` before the existing run-dispatch loop in the 30s tick.
- Create: `server/src/services/work-queue/__tests__/scheduler.test.ts`

`runWorkQueueDrain(opts)`: per spec — compute draw order from credits, walk per-company calling `dequeueOneForCompany` + `materializeWorkItem` + increment credits, until the per-tick budget (default 100) is exhausted. Then UPDATE `work_queue_tenant_credits` SET `recent_dequeued = 0` (rolling reset; the tick itself is the rolling window). Tests verify draw order honored + budget respected + idempotent on empty queue.

## Task 13: pokeScheduler

**Files:**

- Create: `server/src/services/work-queue/poke.ts`
- Create: `server/src/services/work-queue/__tests__/poke.test.ts`
- Modify: `server/src/routes/work-queue.ts` — call `pokeScheduler` after a successful enqueue.

`pokeScheduler(companyId?)` — fire-and-forget signal that wakes the heartbeat scheduler tick early (debounced). Avoids waiting up to 30s on webhook-driven workloads. Implementation: shared in-memory event-emitter the heartbeat tick listens to; takes the early-tick if it's been > min_interval since the last drain. Tests: poke triggers the tick; multiple pokes within debounce window don't pile up.

## Task 14: OTel messaging spans

**Files:**

- Create: `server/src/services/work-queue/spans.ts`
- Modify: `server/src/services/work-queue/service.ts` — wrap enqueue + dequeue with the spans.
- Create: `server/src/services/work-queue/__tests__/spans.test.ts` (in-memory exporter assert).

Spans per Stable 2026 messaging semconv:
- `paperclip.work_queue.create` — emitted by enqueue. Attributes: `messaging.system=paperclip-work-queue`, `messaging.destination.name=<queue>`, `messaging.message.id=<workItemId>`, `messaging.operation=create`.
- `paperclip.work_queue.process` — emitted by materializeWorkItem. Same shape with `messaging.operation=process`. Becomes the parent of the `gen_ai.agent.invoke` already emitted by the run.

## Task 15: metrics

**Files:**

- Create: `server/src/services/work-queue/metrics.ts`
- Modify: `server/src/services/work-queue/scheduler.ts` — emit depth/latency/retry counters.
- Create: `server/src/services/work-queue/__tests__/metrics.test.ts`

Counters / histograms / gauges per spec:
- `paperclip_work_queue_depth{company,queue}` — gauge (scheduler tick reads `COUNT(*) WHERE state='queued'`).
- `paperclip_work_queue_dequeue_latency_ms` — histogram (now - enqueued_at on dequeue).
- `paperclip_work_queue_retry_total{retry_class}` — counter.
- `paperclip_work_queue_dead_letter_count{company}` — gauge.
- `paperclip_work_queue_fairness_drift{company}` — gauge (5min rolling actual / expected).

Same lazy-meter pattern as `services/artifacts/metrics.ts`.

## Task 16: admin UI page

**Files:**

- Create: `ui/src/pages/AdminWorkQueue.tsx`
- Create: `ui/src/api/work-queue.ts`
- Modify: `ui/src/App.tsx` — register route.
- Create: `ui/src/pages/__tests__/AdminWorkQueue.test.tsx`

Three sections: (1) per-company depth panel reading from a new admin endpoint that wraps `paperclip_work_queue_depth`; (2) dead-letter inspector — table view with filter by company / age / error_code; (3) replay-one button per row → POST `/admin/work-queue/replay/:itemId`. Reuses existing admin layout. Two corresponding admin routes added in `routes/work-queue.ts`.

## Task 17: plugin-SDK enqueue helper

**Files:**

- Create: `packages/plugin-sdk/src/work-queue.ts`
- Modify: `packages/plugin-sdk/src/index.ts` — re-export.
- Create: `packages/plugin-sdk/src/__tests__/work-queue.test.ts`

Wraps the in-process service so plugin authors call `paperclip.workQueue.enqueue(...)` without touching internals. Honors the same plugin-auth surface (the SDK already gates on plugin company access).

## Task 18: green build + ROADMAP

**Files:**

- Verify: `pnpm -r exec tsc --noEmit` clean.
- Verify: `pnpm test` clean per package.
- Modify: `ROADMAP.md` — flip Work Queues from ⚪ to 🚧 with one-paragraph summary.

End-to-end smoke: an integration test enqueues an item via the webhook, observes the heartbeat tick dequeues + materializes a run, confirms the run completes and the work_item state transitions to `succeeded`.

---

## Risks (operator-facing)

- **Postgres-as-queue scaling.** Up to ~tens of thousands of items/sec on a single primary; document the inflection point in DEPLOYMENT.md and surface a metric (`paperclip_work_queue_depth`) so operators see it coming.
- **Dead-letter pile-up.** A misconfigured routine producing poison work would fill `dead_letter`. Per-company alert when DLQ > 1000 over 24h. Plan 2 ships auto-archival.
- **Fairness drift.** A high-priority spammer in one company could starve others if `weight` is misconfigured. Mitigation: cross-company arbitration is by `weight` only; priority lanes are within-company. The `paperclip_work_queue_fairness_drift` metric pages on for sustained drift.
- **Backwards compatibility with direct issue creation.** The legacy path (routine → `materializeRoutineFiring()`) remains the default. Queue is opt-in via the `enqueue_via_work_queue` flag per routine; old routines keep working unchanged.

---

*Draft: 2026-05-15. Builds on the work-queues spec dated 2026-05-13. Ready to execute task-by-task.*
