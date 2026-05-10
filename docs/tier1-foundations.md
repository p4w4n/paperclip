# Tier-1 Foundations

Five new substrates landed alongside the core control plane. Each ships as a Plan 1 foundation — schema, services, REST, UI, observability — with a Plan 2 follow-up scoped for hosted/sandboxed extensions, plugin contracts, and quality-of-life polish.

Specs: `docs/superpowers/specs/`. Per-area task plans: `docs/superpowers/plans/`. Each plan was executed task-by-task on a chained branch with TDD discipline; all 90 task branches plus the merge from upstream are now in `master`.

---

## Quick reference

| Area | Schema migration | Service module | REST routes | UI page(s) | Spec / Plan |
|---|---|---|---|---|---|
| Memory / Knowledge | `0086_memory_foundation.sql` | `server/src/services/memory/` | (boot-only; agents recall via the `<memory>` prompt-prefix) | — | [spec](superpowers/specs/2026-05-13-memory-knowledge-design.md) / [plan](superpowers/plans/2026-05-14-memory-foundation.md) |
| Artifacts & Work Products | `0087_artifacts_foundation.sql`, `0088_artifacts_legacy_view.sql` | `server/src/services/artifacts/` | `GET /api/issues/:id/artifacts`, `GET /api/artifacts/:id`, `GET /preview/:artifactId/*splat` | Issue → Work Products tab | [spec](superpowers/specs/2026-05-13-artifacts-work-products-design.md) / [plan](superpowers/plans/2026-05-15-artifacts-foundation.md) |
| Work Queues | `0089_work_queues_foundation.sql` | `server/src/services/work-queue/` | `POST /api/companies/:cid/work-queue/:queue/items` (Idempotency-Key), `GET/POST /admin/work-queue/*` | Instance → Work Queue | [spec](superpowers/specs/2026-05-13-work-queues-design.md) / [plan](superpowers/plans/2026-05-15-work-queues-foundation.md) |
| Deep Planning | `0090_deep_planning_foundation.sql`, `0091_routine_requires_plan.sql` | `server/src/services/plans/` | `POST /api/issues/:id/plans`, `GET/POST /api/plans/:id/{revisions,reviews,phases/:pid/{start,complete},decisions}` | Issue → Plan tab, `/plans` index | [spec](superpowers/specs/2026-05-15-deep-planning-design.md) / [plan](superpowers/plans/2026-05-15-deep-planning-foundation.md) |
| Automatic Organizational Learning | `0092_organizational_learning_foundation.sql` | `server/src/services/learning/` | `POST/GET /api/companies/:cid/playbooks`, `POST /api/playbooks/:id/{revisions,approve,archive}`, `POST /api/companies/:cid/playbooks/suggest`, plus pattern + skill + decision-pattern reads | `/admin/learning`, `/agents/:id/skills`, `/learning/patterns` | [spec](superpowers/specs/2026-05-15-organizational-learning-design.md) / [plan](superpowers/plans/2026-05-15-organizational-learning-foundation.md) |

---

## Memory / Knowledge 🚧

**Three-layer model on Postgres + pgvector.** Karpathy's LLM-Wiki gist (April 2026, gist 442a6bf) shapes the architecture.

- `memory_entries` — fact-per-row store with scope columns (company / user / agent / session) and a `vector(1024)` embedding column.
- `memory_pages` — markdown wiki pages, versioned by parent_id chain, with a partial-unique slug index per scope.
- `memory_page_links` — directed graph for cross-page references; recall expands 1-hop links by default.

**Lifecycle.** The heartbeat writes episodic facts on every run boundary (start, finish, comment-driven wake — comment author + body fetched via `issueComments`). The reflection worker (booted at 30s interval) backfills embeddings, promotes recent episodics to semantic facts via the LLM (`extract-semantic`), and clusters semantic facts into wiki pages (`ingest-page`). Plan completion in Deep Planning fires `ingestCompletedPlan` to write a procedural wiki page + one semantic fact per `plan_decision`.

**Recall.** Hybrid union-rank (vector cosine + keyword ILIKE, 0.7 / 0.3 weights). Heartbeat calls `recall` + `recallPages` before `adapter.execute()` and prepends the rendered `<memory>` block (suggested playbooks → wiki pages → facts, ~6KB budget) to `context.paperclipMemoryPreamble`. The `claude-local` and `gemini-local` adapters read the field and prepend it to their prompt.

**Embedders.** Three providers behind a single `EmbeddingProvider` interface, selected via `PAPERCLIP_EMBEDDING_PROVIDER`:
- `voyage-3-large` (best retrieval; needs `VOYAGE_API_KEY`)
- `text-embedding-3-large` (OpenAI; needs `OPENAI_API_KEY`)
- `ollama` (free, local — `ollama pull bge-m3` once and the worker auto-detects on next boot)

The Ollama probe refuses to bind if the configured model emits a non-1024 dimension, so a wrong model can't silently corrupt the vector column. Without any embedder, recall degrades to keyword-only and the worker no-ops.

**PII redaction.** Regex layer (emails, phones, SSN-shape, credit-card-shape, AWS access keys, GitHub PATs, IPv4) applied to every fact before write; LLM-classifier interface stubbed for Plan 2 (names, addresses).

---

## Artifacts & Work Products 🚧

**Unified manifest with content-addressed blob dedup.** Replaces the scattered `heartbeat_runs.summary` / `document_revisions` / `issue_work_products` / "files in the workspace" surfaces with one typed object.

- 7 kinds in v1: `code.file`, `code.patch`, `doc.markdown`, `doc.office`, `chart`, `data.table`, `web.app`. JSON Schema validators in `packages/shared/src/artifact-kinds/`.
- sha256-keyed storage layout `<companyId>/artifacts/blobs/<sha[:2]>/<sha>` so identical content across runs shares one storage object. `head` probe before `put` makes dedup observable.
- `parent_id` chain on supersession; partial-unique on `(issue_id, name) WHERE superseded_at IS NULL` admits exactly one active artifact per logical name.

**Declare paths.**
- **In-process** — `claude-local` / `gemini-local` adapters call `declareArtifactInProcess({...})` (a future declare-artifact tool surfaces this to the LLM).
- **Distributed worker** — `WorkerToServer.ArtifactDeclared` proto frame; the connect-handler routes to `ArtifactsService.declare()` and replies with an `ArtifactDeclareAck` carrying the manifest id.

**Preview provider plugin.** `PreviewProvider` interface + a built-in `local` provider that renders code / markdown / chart / data.table / image inline from the control plane. Refuses `web.app` (security); a Plan 2 e2b/Cloudflare provider takes that surface. Reaper sweeps expired previews every 5 min.

**Back-compat.** `artifact_work_products_compat` SQL view exposes the new `artifacts` rows in the old `issue_work_products` column shape so plugins reading the legacy table keep working.

---

## Work Queues 🚧

**Postgres-native fanout. No Redis.** Two tables (`work_items`, `work_queue_tenant_credits`) with three hand-edited partial indexes:

- `work_items_dedupe_active_uniq` UNIQUE `(company_id, dedupe_key)` WHERE `dedupe_key IS NOT NULL AND state IN ('queued','running')` — Stripe-style idempotency.
- `work_items_dequeue_idx` `(company_id, queue, priority DESC, available_at)` WHERE `state='queued'` — the scheduler's hot path.
- `work_items_dead_letter_idx` `(company_id, completed_at DESC)` WHERE `state='dead_letter'` — admin DLQ inspection.

**Scheduler.** Per-tick (default 30s), walks all companies in fairness order — `credits = weight - recent_dequeued`, sorted desc — and pulls one item per company per round via `FOR UPDATE SKIP LOCKED` until either the per-tick budget (default 100) or every company is exhausted. After the loop, `recent_dequeued` resets — the tick itself is the rolling fairness window.

**Materialization.** Each dequeued item inserts a `heartbeat_runs` row with `invocationSource='work_queue'`, links via `work_item.run_id`, and bumps `recent_dequeued` atomically inside the same tx. Routine-driven items (`routine_id` set on the work_item) call back into `routine.materialize()` to resolve `(issueId, agentId)`.

**Failure classification.** `classifyFailure(errorCode, errorMessage)` → `transient_provider | transient_local | poison | quota_exceeded | permanent`. `applyRetryPolicy` defaults: exponential backoff capped 5min for provider transient; immediate retry for local transient; `dead_letter` for poison/permanent; deferred-to-next-budget-window for quota (does not count against attempts).

**Webhook + admin.**
- `POST /api/companies/:cid/work-queue/:queue/items` — body is the enqueue payload, `Idempotency-Key` header maps to `dedupe_key`.
- `POST /admin/work-queue/{replay,cancel}/:itemId` — instance-admin gated.
- `GET /admin/work-queue` — per-(company, queue) depth + recent dead-letter rows for the `/instance/work-queue` page.

`pokeScheduler(companyId)` fires after a successful enqueue to wake the heartbeat tick early — debounced per-company at 1s.

---

## Deep Planning 🚧

**A versioned `plans` layer attached to issues.** Strategy-heavy work moves out of the issue thread and into a curated, reviewable, phase-decomposed object.

Seven tables: `plans` (lifecycle + approval policy), `plan_revisions` (snapshot+parent), `plan_phases` (ordered + DAG), `plan_phase_dependencies`, `plan_reviews` (decisions stamped per revision), `plan_decisions` (durable rationale), `plan_phase_runs`.

**Lifecycle.** `draft → under_review → approved → in_progress → completed` (or `cancelled`/`rejected` pre-progress). Re-revising under `approved`/`in_progress` re-triggers review when the policy demands it. Phase lifecycle: `pending → ready → in_progress → completed | skipped | blocked`.

**Phase-DAG.** Phase dependencies are explicit edges; cycle-check is service-layer (DFS pre-insert). `phaseReadiness({depStatuses})` returns ready / pending / blocked.

**Phase ↔ Work Queue bridge.** `enqueuePhaseWork({planId, phaseId})` pushes a work-queue item with payload `{planContext: {planId, phaseId}}`; the work-queue scheduler's routine-materializer resolves `(issueId, agentId)` from the plan. Run completion fires `onRunCompletedForPhase` which auto-advances the phase if the run summary mentions every unchecked exit-criteria item.

**Memory + Artifacts integration.** On plan completion, `ingestCompletedPlan` writes a procedural wiki page (`plan-${planId}-final` slug) + one semantic memory fact per decision. Artifacts can be filtered by `content_meta.plan_id` via `GET /api/plans/:id/artifacts`.

**UI.** Plan tab on issue detail: current revision (markdown), phase tree (status pills + Start/Complete buttons gated on readiness), decision log, revision diff, review surface (Approve / Request changes / Reject). Plus a `/plans` index page filterable by status.

---

## Automatic Organizational Learning 🚧

**Mining + suggestion above the capture layers.** Turns the byproducts of Memory + Artifacts + Plans into actively-suggested procedural reuse.

Five tables: `playbooks` (lifecycle: `proposed → active → archived | superseded`, `applicability_conditions JSONB`, hand-edited partial-unique slug-active index), `playbook_revisions`, `outcome_patterns` (mined clusters), `agent_skills` (per-agent profile, decay over 30/90 days), `decision_patterns` (aggregated rationale across plans).

**Miners (extend the memory reflection worker).**
- `clusterRunsByTitle(runs)` — cosine over title embeddings or Jaccard fallback. Stable signature so re-mining doesn't spawn duplicates; existing patterns extend evidence instead.
- `extractSkillsFromRun(runSummary, llm)` — kebab-case skill tags from run summaries; `computeSkillDecay({confidence, lastEvidencedAt})` drops 0.1/month past `lastEvidencedAt`.
- `groupDecisionsByCondition(decisions, llm)` — token-signature clusters across `plan_decisions`; LLM synthesizes condition + typical-choice.

**Suggestion hot path.** `matchPlaybookApplicability(issueContext, playbook)` is a pure function (keyword × 0.2, label × 0.3, project × 0.5, agent × 0.4, multiplied by playbook confidence, clamped to 1). `suggestPlaybooks(...)` returns top-N over the threshold (default 0.3, env-overridable). The result feeds into the Memory prompt-prefix as a `## Suggested playbooks` section above wiki pages + facts.

**Cache.** In-memory LRU on `(companyId, hash(issueContext))` with 60s TTL + 1000 entries. Admin curation (approve / archive / promote) calls `invalidateCompany` so suggestions track operator edits without staleness.

**UI.** `/admin/learning` surfaces proposed-vs-active playbooks, outcome patterns, and decision patterns side-by-side with Approve/Archive/Promote buttons. `/agents/:id/skills` shows each agent's profile with confidence bars + last-evidenced timestamps. `/learning/patterns` is the public read dashboard.

---

## Smoke test

```bash
./scripts/smoke/tier1-e2e.sh
```

Spins up `pnpm exec tsx server/src/index.ts` with `local_trusted` auth + an embedded Postgres, applies all 93 migrations, then walks: company → agent → issue → plan(2 phases + decision) → playbook + suggest → work-queue with `Idempotency-Key` dedup → artifacts list. Total runtime ~20s.

Override the work directory with `PAPERCLIP_E2E_DIR=/path` (default `/tmp/paperclip-e2e`); override the port with `PAPERCLIP_PORT=NNNN` (default 3198).

---

## What's next

Each Plan 1 has a documented Plan 2 follow-up scope. None of those are scheduled yet.

- Memory Plan 2 — Mem0/Letta plugin adapters, embedding-based clustering for ingest-page, int8 quantization, MCP-Resource adapter for `paperclip://memory/...`, `/admin/memory` UI.
- Artifacts Plan 2 — e2b + Cloudflare preview providers, MCP-Resource adapter for `paperclip://artifacts/...`, orphan-blob GC sweep, `document_revisions` consolidation.
- Work Queues Plan 2 — per-queue concurrency caps, DLQ auto-archival, Kafka/pubsub source plugins, deadline-aware scheduling.
- Deep Planning Plan 2 — plan templates, planner-agent role, phase parallelism caps, auto-archival, parent → child sub-plan composition.
- Org Learning Plan 2 — MCP-Resource adapter for `paperclip://learning/...`, auto-execution of playbooks under Enforced Outcomes, cross-company industry-template plugins, skill canonicalization.

Two new Tier-1 areas not started: **Enforced Outcomes** (tasks resolve to merged code / shipped artifacts / explicit decisions) and **MAXIMIZER MODE** (orchestration-layer autonomy).
