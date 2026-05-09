# Work Queues Design

> Spec for the **Work Queues** roadmap milestone. Grounded in the May 2026 state-of-the-art (Temporal Replay 2026, Inngest, Trigger.dev v4, Hatchet, river-queue, pg-boss, OpenTelemetry messaging semconv stable). See `docs/research/2026-05-13-work-queues-research-brief.md` for the underlying research.

## Problem

Paperclip ingests work two ways today:

- A human creates an issue, comments on it, or assigns it; the heartbeat scheduler picks up runs.
- A `routine` fires on cron and creates an issue.

Both paths land in the same `heartbeat_runs` table and ride the same 30-second scheduler tick. There is no programmatic ingestion lane for repeating, fanout-style work — support tickets streaming in from a queue, a backlog of code reviews to run nightly, an inbox of triage items where each item should become an agent run with idempotency and per-tenant fairness. Operators today either spam the API with manual `createIssue` calls (no idempotency, no fairness) or build it themselves with BullMQ / Temporal / Inngest as an external system, losing the run-as-issue model.

The 2026 industry consensus is **durable execution as default**: every job is journaled, replay never re-charges LLM tokens, idempotency keys are first-class, and per-tenant fairness is a named feature. Paperclip already has the durable side (heartbeat_runs is the row, lease_expires_at is the durability column, the lease reaper survives restarts). What's missing is the **ingestion** layer that fans incoming work into the run model with the right serialization and back-pressure semantics.

## Goals

1. A `work_items` table that holds queued-but-not-yet-dispatched work, with: idempotency key, per-tenant fairness, priority, retry policy, dead-letter, OTel messaging semconv from day 1.
2. **Postgres-native** — no Redis dependency, no separate orchestrator. Reuse the SKIP LOCKED + partial-unique pattern paperclip already shipped in `workspace_leases` (Plan 4 of the workers spec).
3. **Three ingestion sources**: webhook (HTTP POST), cron (extends existing `routines`), programmatic API (`enqueue` for plugin authors and external callers).
4. **Per-tenant fairness** via weighted round-robin draw, *not* sharded tables. Hatchet's pattern; simpler operator story for self-host.
5. **Idempotency keys** as a first-class column. The partial unique on `dedupe_key WHERE state IN ('queued','running')` is the same lock primitive as workspace_leases.
6. **Cost-aware retry**: classify provider 429 vs 5xx vs poison before retry; configurable per-routine retry policy.
7. **OpenTelemetry messaging spans** (`create`, `send`, `process`) plus the GenAI agent semconv on the LLM call inside the activity. Free dashboards in Grafana / Honeycomb.
8. **Materialization into runs** — a queued work_item becomes a heartbeat_run on dequeue, the existing dispatcher takes over from there.

## Non-goals (v1)

- **Full Temporal-style replay journal.** Per-step idempotent re-execution at the run grain (Trigger.dev / river-queue model) is the right fit for paperclip's TS / Postgres stack. A workflow-step replay journal is much heavier and not warranted for v1's primary use case (fanout into issue-shaped agent runs).
- **Multi-region / cross-zone fairness.** v1 assumes a single Postgres primary.
- **Exactly-once across distributed workers.** "At-least-once with idempotency key" is the contract; the run-completion side already absorbs duplicate `RunComplete` frames (Plan 2 Task 4 late-frame drop).
- **Custom dequeue strategies as a plugin extension.** v1 ships one strategy (weighted round-robin per company, priority lanes within company). Per-routine strategy hooks are a v2 concern.
- **Cron-style scheduling inside work_items.** That lives in `routines` already; a routine fires → enqueues a work_item. Don't duplicate the cron infra.
- **Streaming queues / change-data-capture sources.** Webhooks and explicit enqueues only. Kafka / pubsub adapters can land as plugins later.

## Architecture

```
┌──────────────────────┐
│  Ingestion sources   │
│                      │
│  ┌────────────────┐  │
│  │ webhook (HTTP) │──┐
│  └────────────────┘  │
│  ┌────────────────┐  │       ┌────────────────────────────┐
│  │ routine (cron) │──┼──────►│  work-queue service        │
│  └────────────────┘  │       │  enqueue(item)             │
│  ┌────────────────┐  │       │                            │
│  │ enqueue() API  │──┘       │  ┌──────────────────────┐  │
│  └────────────────┘          │  │  work_items          │  │
└──────────────────────┘       │  │  (priority, fairness │  │
                               │  │   keys, dedupe)      │  │
                               │  └──────────┬───────────┘  │
                               └─────────────┼──────────────┘
                                             │
                               ┌─────────────▼──────────────┐
                               │  work-queue scheduler      │
                               │  (extends 30s heartbeat    │
                               │   tick; SKIP LOCKED        │
                               │   weighted round-robin)    │
                               │                            │
                               │  dequeue(N) → materialize  │
                               │  into heartbeat_runs       │
                               └─────────────┬──────────────┘
                                             │
                                             ▼
                               ┌────────────────────────────┐
                               │  Existing dispatcher       │
                               │  (Plan 1 distributed       │
                               │   workers; routes to       │
                               │   workers)                 │
                               └────────────────────────────┘
```

### Schema

```sql
CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Queue name; default 'default'. A company may run multiple queues
  -- with independent priority weighting.
  queue TEXT NOT NULL DEFAULT 'default',
  -- Priority within (company, queue). Higher first. 0..9.
  priority SMALLINT NOT NULL DEFAULT 5,
  -- Idempotency. The partial unique below is the actual lock.
  dedupe_key TEXT,
  -- Routing. Either an issue + agent are pre-resolved (the most common
  -- shape — "make a run on this issue with this agent") OR a routine_id
  -- is supplied (let the routine decide on dequeue).
  target_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  routine_id      UUID REFERENCES routines(id) ON DELETE SET NULL,
  -- Free-form payload. UI / plugin authors define the shape per queue.
  payload JSONB,
  -- Lifecycle.
  state TEXT NOT NULL DEFAULT 'queued',
    -- 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled'
  -- Scheduling.
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retries. Cost-aware: retry_class chosen by the failure classifier.
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  retry_policy    JSONB,  -- {"on_429": "backoff_minutes", "on_5xx": "retry_3", ...}
  -- Provenance.
  enqueued_by_kind TEXT NOT NULL,  -- 'webhook' | 'routine' | 'api' | 'human'
  enqueued_by_ref  TEXT,           -- routine_id / api-token-id / user-id
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- Materialized run reference (set once dequeue succeeds).
  run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  -- Failure record.
  last_error TEXT,
  last_error_code TEXT
);

-- Idempotency: at most one un-completed item per (company, dedupe_key).
-- Same shape as workspace_leases_active_workspace_uniq from Plan 4 of
-- the workers spec.
CREATE UNIQUE INDEX work_items_dedupe_active_uniq ON work_items
  (company_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');

-- Dequeue index. Ordered by priority desc, then available_at asc.
CREATE INDEX work_items_dequeue_idx ON work_items
  (company_id, queue, priority DESC, available_at)
  WHERE state = 'queued';

-- Dead-letter inspection.
CREATE INDEX work_items_dead_letter_idx ON work_items
  (company_id, completed_at DESC) WHERE state = 'dead_letter';

-- Fairness counter. Updated atomically on dequeue.
CREATE TABLE work_queue_tenant_credits (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Weight knob; defaults to 1.0. Operators tune per company.
  weight REAL NOT NULL DEFAULT 1.0,
  -- Rolling counter; reset by the scheduler each tick.
  recent_dequeued INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Enqueue API

```ts
interface EnqueueInput {
  companyId: string;
  queue?: string;          // default 'default'
  priority?: number;       // 0..9, default 5
  dedupeKey?: string;
  // Routing: either pre-resolved or routine-driven
  targetIssueId?: string;
  targetAgentId?: string;
  routineId?: string;
  payload?: Record<string, unknown>;
  // Retry policy override
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  // Schedule
  availableAt?: Date;      // deferred enqueue
}

interface EnqueueResult {
  // Returns { enqueued: false, reason: 'duplicate', existingId } when
  // the dedupe_key collides with an active item — caller knows their
  // request was absorbed without spamming the queue.
  enqueued: boolean;
  workItemId: string;
  reason?: 'duplicate' | 'queue_paused';
  existingId?: string;
}
```

### Dequeue / scheduler

The existing `heartbeatScheduler.ts` 30s tick gains a step:

1. Compute per-company *credits* (weighted round-robin): for each company that has queued items, `credits[company] = weight[company] - recent_dequeued[company]`. Sort companies by credits desc.
2. Walk in order, draw 1 item per company round-by-round until the per-tick budget is exhausted (configurable; default 100 items per tick). Within a company, order by `(priority DESC, available_at ASC)`.
3. The dequeue SQL is `SELECT … FROM work_items WHERE company_id = $1 AND state = 'queued' AND available_at <= now() ORDER BY priority DESC, available_at LIMIT 1 FOR UPDATE SKIP LOCKED` (per-company query inside the loop).
4. For each dequeued item: insert a heartbeat_run, set `work_items.run_id`, transition `state = 'running'`, increment `recent_dequeued[company]`.
5. The existing dispatcher takes the run from there; on completion the connect-handler updates the work_item state.

The fairness pattern is: companies with weight=2 get drawn twice as often as weight=1; `recent_dequeued` resets every tick so back-to-back ticks don't starve a low-weight tenant.

### Failure classification + retry

A new helper `classifyFailure(errorCode, errorMessage)` maps run failure into one of:

- `transient_provider` — 429 / 5xx / network blip → retry with `retry_policy.backoff` (default exponential, capped 5min).
- `transient_local` — worker died, lease expired → retry immediately at the head of the queue.
- `poison` — adapter parse error, schema validation failure → no retry; straight to dead-letter.
- `quota_exceeded` — company budget hit → defer to start of next budget window.
- `permanent` — explicit `RunFailed` with `errorCode = "permanent"` → dead-letter.

The classifier is per-routine-overrideable via `retry_policy` JSONB.

### Triggers / ingestion

**Webhook.** A new route `POST /api/companies/:companyId/work-queue/:queue/items` accepts an enqueue payload and a header-based idempotency key (Stripe-style). Body is forwarded as `payload`. Auth via existing API key system.

**Cron / routine.** Routines that already produce issues gain an opt-in flag `enqueue_via_work_queue` — instead of directly creating the issue, the routine enqueues a work_item with `routine_id` set. The dequeue step calls the routine's existing `materialize()` to produce the issue+run.

**Programmatic API.** Plugin authors call `workQueueService.enqueue(input)` directly. SDK wrapper lands in `@paperclipai/plugin-sdk`.

## Lifecycle and states

```
queued ─────► running ─────► succeeded
   │             │
   │             ├── transient → queued (attempts++, available_at = now() + backoff)
   │             ├── poison    → dead_letter
   │             └── quota     → queued (available_at = next budget window)
   │
   └── cancelled (operator action)
```

## Observability

Wired to OTel messaging semconv (Stable 2026):

- `paperclip.work_queue.create` span when an item is enqueued.
- `paperclip.work_queue.process` span when a worker materializes the run; child span is the existing `gen_ai.agent.invoke`.
- Metrics:
  - `paperclip_work_queue_depth{company,queue}` (Gauge; emitted by the scheduler tick)
  - `paperclip_work_queue_dequeue_latency_ms` (Histogram)
  - `paperclip_work_queue_retry_total{retry_class}` (Counter)
  - `paperclip_work_queue_dead_letter_count{company}` (Gauge)
  - `paperclip_work_queue_fairness_drift{company}` (Gauge — actual / expected dequeue ratio over a 5min window)

Admin UI: `/admin/work-queue` shows per-company depth, p50/p95 dequeue latency, dead-letter inspector with replay-one button.

## Failure modes

| Failure | Behavior |
|---|---|
| Postgres write contention on enqueue | The partial unique on `dedupe_key` rejects duplicates → caller sees `{enqueued: false, reason: 'duplicate'}` |
| Postgres outage during dequeue | Existing scheduler tick logs and retries on next tick; no items get lost (durable in `work_items`) |
| Worker dies mid-run | Plan 2 lease reaper from the workers spec catches it; the run fails → work-queue scheduler observes via the lease_expired error_code → retries per `retry_policy` |
| Item never dequeues (starvation) | Fairness check: `paperclip_work_queue_fairness_drift` pages on if a company's actual / expected ratio falls below 0.5 for 5 minutes. Operators tune `weight`. |
| Dead-letter pile-up | Admin UI shows count; replay-one button re-queues with `attempts = 0`; bulk replay endpoint with company-admin auth |
| MultiXact bloat (per richyen.com) | Mitigation: scheduler's `FOR UPDATE SKIP LOCKED` only touches small N per tick (default 100). Add an alert on `pg_stat_database.deadlocks` and the multixact age. |
| Duplicate webhook delivery | Idempotency key on webhook → dedupe_key on work_item → second request sees `{enqueued: false}` |

## Phasing

1. **Schema + enqueue / dequeue primitives.** `work_items` + `work_queue_tenant_credits`. SDK service. No new ingestion routes yet.
2. **Scheduler integration.** Existing 30s tick learns to draw from `work_items` with weighted round-robin; materialization to heartbeat_runs.
3. **Failure classification + retry policy.** `classifyFailure`; per-routine `retry_policy`.
4. **Routine integration.** `enqueue_via_work_queue` flag; routine `materialize()` is called on dequeue.
5. **Webhook ingestion.** `POST /api/companies/:companyId/work-queue/:queue/items` with idempotency-key header.
6. **OpenTelemetry messaging semconv.** Spans + metrics. Dashboards.
7. **Admin UI: `/admin/work-queue`.** Depth panel, dead-letter inspector, replay buttons.
8. **Plugin SDK enqueue helper.** `@paperclipai/plugin-sdk` exposes `workQueue.enqueue`.

Phases 1-4 deliver a usable queue; 5-8 are quality-of-life and operator surface.

## Risks

- **Postgres-as-queue scaling.** Up to ~tens of thousands of items/sec on a single primary (river-queue's number on a beefy box). Above that, sharding per-company tenant-by-tenant is the escape hatch. Document the inflection point in DEPLOYMENT.md.
- **Fairness gaming.** A company could spam high-priority items to starve others. Mitigation: priority lanes are within-company; cross-company arbitration is by `weight` only. Operators can clamp priority via per-company config.
- **Dead-letter pile-up.** A misconfigured routine emitting poison work would fill `dead_letter` rows. Mitigation: per-company DLQ size cap; emit warning when >1000 dead-letter rows over 24h.
- **Scheduler tick latency.** 30s default may be too slow for webhook-driven workloads. Mitigation: a configurable per-queue `min_tick_interval_ms`; a webhook can also trigger an immediate `pokeScheduler()`.
- **Backwards compatibility with direct issue creation.** v1 keeps both paths working; queue is opt-in per routine / webhook.

## Decisions following review (2026-05-13)

- **Postgres-native, single table.** No Redis, no Temporal, no separate orchestrator.
- **Same lock primitive as `workspace_leases`** — partial unique on `dedupe_key WHERE state IN ('queued','running')`. The Plan 4 pattern proven in production carries over.
- **Weighted round-robin fairness via in-SQL credits**, not sharded tables. Hatchet's pattern; simpler operator story.
- **Failure classification is core, retry policy is per-routine-overrideable.** Classifier ships with sensible defaults; routines tune as needed.
- **Existing 30s heartbeat tick is the dequeue cadence.** Avoids a second scheduler loop. Per-queue overrides for low-latency queues.
- **OTel messaging semconv from day 1.** Free observability, future-proof.

## Notes on deferred concerns

- **Plugin-extensible dequeue strategies.** The default WRR + priority is enough for v1. If product needs land that can't be expressed (deadline-aware scheduling, capacity-reservation), revisit in v2.
- **Streaming sources (Kafka, pubsub).** Lands as plugins that proxy events into `enqueue()`. Out of scope for v1.
- **Cross-region replication.** Single primary in v1. Multi-region postgres is a separate infrastructure concern.
- **Workflow-graph orchestration.** Temporal/LangGraph-style multi-step workflows are out of scope. The unit is a single agent run; multi-step is composed at the issue level (parent issue → child issues).

## Open questions

1. **Webhook auth model.** Per-queue API key, or per-company plus a header-scoped queue name? Stripe-style is per-queue; simpler self-host story is per-company.
2. **DLQ replay default.** Re-queue with `attempts = 0` (treat as fresh) or `attempts = max_attempts - 1` (one more chance, then permanent)? Probably the former, with an opt-in `retry_count` parameter on the replay endpoint.
3. **Per-tenant rate-limits on enqueue.** Should the enqueue API itself rate-limit per company, or rely on the scheduler's fairness pull-pattern to absorb? The latter is simpler but means a noisy tenant can fill the table; the former adds complexity but caps storage.
4. **Per-queue concurrency cap.** Should `(company, queue)` have a max-concurrent setting (e.g., "queue 'reviews' runs at most 3 at a time")? Useful for cost containment; adds a second concurrency primitive next to `workspace_leases`.
5. **Backfill on enable.** When a company turns on a queue, should we snapshot existing pending issues into work_items? Probably not — keep migration explicit.

---

*Draft: 2026-05-13. Review with: spec author + ops lead + plugin SDK reviewer. Plan document follows once the open questions resolve.*
