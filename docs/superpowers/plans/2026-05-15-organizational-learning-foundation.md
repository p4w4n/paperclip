# Automatic Organizational Learning Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-15-organizational-learning-design.md`. This plan delivers: the four learning tables (`playbooks`, `playbook_revisions`, `outcome_patterns`, `agent_skills`, `decision_patterns`), the `OrgLearningService` write/read path with tenant isolation, the pure pattern-miner / skill-miner / decision-pattern-aggregator helpers, the production wires that extend the memory reflection worker, the applicability matcher + heartbeat suggestion hook, REST + UI surfaces (`/admin/learning` curation, agent skills page, pattern dashboard), and OTel spans + metrics. MCP-Resource exposure lands with Memory Plan 2's MCP server.

**Architecture:** New `server/src/services/learning/` module. Workers extend `server/src/services/memory/reflection-worker.ts` with three additional stages (pattern, skill, decision-pattern). The applicability matcher is pure; `suggestPlaybooks` is the hot-path entry point called by heartbeat just before the run begins. Suggestion output prepends to the existing `<memory>` prompt-prefix (`context.paperclipMemoryPreamble`).

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres). Builds on Memory (Plan 1), Artifacts (Plan 1), Work Queues (Plan 1), and Deep Planning (Plan 1) all already in master.

**Scope split (this plan covers Plan 1 of 2 for organizational learning):**

- ✅ This plan: schema + service contract; playbook CRUD + revision chain; applicability matcher; pattern miner (clustering + LLM-synthesize); skill miner (LLM tagging + decay); decision-pattern aggregator; suggestion hook into heartbeat; REST endpoints; UI `/admin/learning` + agent-skills + pattern-dashboard; OTel spans + metrics.
- ⏭ Plan 2: MCP-Resource adapter for cross-vendor read; auto-execution of playbooks under enforced outcomes; cross-company industry-templates plugin; adaptive scheduling using skill profiles; skill canonicalization via a curated taxonomy.

---

## File Structure

**Created:**

- `packages/db/src/schema/playbooks.ts` — Drizzle schema for the playbook container.
- `packages/db/src/schema/playbook_revisions.ts` — versioned revisions.
- `packages/db/src/schema/outcome_patterns.ts` — mined clusters.
- `packages/db/src/schema/agent_skills.ts` — per-agent profile rows.
- `packages/db/src/schema/decision_patterns.ts` — aggregated decision rationale.
- `packages/db/src/migrations/0090_organizational_learning_foundation.sql` — DDL with the partial-unique on (company_id, COALESCE(agent_id::text, ''), slug) WHERE status='active'.
- `server/src/services/learning/types.ts` — `OrgLearningService` contract; `Playbook` / `OutcomePattern` / `AgentSkill` / `DecisionPattern` shapes; `LearningTenantMismatchError`.
- `server/src/services/learning/service.ts` — in-process service.
- `server/src/services/learning/applicability.ts` — pure `matchPlaybookApplicability`.
- `server/src/services/learning/pattern-miner.ts` — pure clustering + LLM-synthesize helper.
- `server/src/services/learning/skill-miner.ts` — pure tagging + decay helper.
- `server/src/services/learning/decision-aggregator.ts` — pure decision-pattern aggregator.
- `server/src/services/learning/suggest.ts` — `suggestPlaybooks(svc, ctx, issueContext)` — top-N applicability ranking.
- `server/src/services/learning/spans.ts` — OTel span helpers.
- `server/src/services/learning/metrics.ts` — OTel metrics.
- `server/src/services/learning/__tests__/*.test.ts` — one per module.
- `server/src/routes/learning.ts` — REST endpoints (CRUD, list, suggest, promote, approve).
- `ui/src/api/learning.ts` — UI client.
- `ui/src/pages/AdminLearning.tsx` — `/admin/learning` curation page.
- `ui/src/pages/AgentSkills.tsx` — per-agent skill profile.
- `ui/src/pages/LearningPatterns.tsx` — pattern dashboard.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export the new tables.
- `server/src/services/memory/reflection-worker.ts` — extend `reflectionTick` with pattern + skill + decision-pattern stages (gated by env flag for cost control).
- `server/src/services/heartbeat.ts` — in `executeRun`, after the existing memory-recall block, call `suggestPlaybooks` and prepend the top match(es) to `context.paperclipMemoryPreamble`.
- `server/src/index.ts` — initialize `OrgLearningService` singleton at boot.
- `server/src/app.ts` — register `learningRoutes`.
- `ui/src/App.tsx` — register `/admin/learning`, `/agents/:id/skills`, `/learning/patterns` routes.
- `ROADMAP.md` — flip Automatic Organizational Learning ⚪ → 🚧 in L-18.

**Migration:** `0090_organizational_learning_foundation.sql`. All four tables + the partial-unique slug index. Same hand-edit pattern as 0084/0085/0087/0088 (drizzle-kit doesn't emit partial-WHERE).

---

## Conventions used in this plan

Same as the previous Tier-1 plans (memory, artifacts, work-queues, deep-planning):

- **Test framework:** Vitest. Single file: `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate`, then rename + update `meta/_journal.json`.
- **Commit style:** conventional commits matching existing history. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: schema + migration

**Files:**

- Create: 5 schema files in `packages/db/src/schema/`.
- Create: `packages/db/src/migrations/0090_organizational_learning_foundation.sql`.
- Modify: `packages/db/src/schema/index.ts`.

Per the spec's DDL. Hand-edited:
- `playbooks_slug_active_uniq` partial unique on `(company_id, COALESCE(agent_id::text, ''), slug) WHERE status='active'`. Same shape as `memory_pages_slug_active_uniq` from Plan 1 of Memory.

Verify: `pnpm --filter @paperclipai/db test src/client.test.ts`.

## Task 2: OrgLearningService contract

**Files:**

- Create: `server/src/services/learning/types.ts`
- Create: `server/src/services/learning/__tests__/types.test.ts`

Mirror the spec's TypeScript interface. `LearningTenantMismatchError` shape matches the other Tier-1 services.

## Task 3: applicability matcher (pure)

**Files:**

- Create: `server/src/services/learning/applicability.ts`
- Create: `server/src/services/learning/__tests__/applicability.test.ts`

Pure `matchPlaybookApplicability(issueContext, playbook) → {score, reason}` per the spec's TypeScript snippet. Tests cover keyword / label / project-scope / agent-scope / confidence-multiplier paths and the score-clamp at 1.0.

## Task 4: playbook CRUD + revision chain

**Files:**

- Create: `server/src/services/learning/service.ts` (initial scope: createPlaybook, revisePlaybook, approvePlaybook, archivePlaybook, listPlaybooks).
- Create: `server/src/services/learning/__tests__/service-playbook.test.ts`

`createPlaybook` writes playbook + initial revision in one tx, sets `current_revision_id`. `revisePlaybook` inserts a new revision, bumps revision counters. `approvePlaybook` transitions status `proposed → active`. `archivePlaybook` sets `status=archived` + `archived_at`. Tenant gate via assertTenant on every method. Tests cover the slug partial-unique race (concurrent active insert returns 409), the revision-chain ordering, and tenant rejection.

## Task 5: pattern miner — pure clustering helper

**Files:**

- Create: `server/src/services/learning/pattern-miner.ts`
- Create: `server/src/services/learning/__tests__/pattern-miner.test.ts`

Pure: `clusterRunsByTitle(runs, opts) → Cluster[]` where Cluster = `{exemplarRunIds, titleSummary, size}`. Default uses cosine over embeddings if available; fallback to Jaccard over tokenized titles. Tests cover empty / singleton / 5-run cluster / two-cluster split.

## Task 6: pattern miner — DB worker integration

**Files:**

- Modify: `server/src/services/memory/reflection-worker.ts` — add a `mineOutcomePatterns(opts)` stage that runs after `embedPendingPages`.
- Create: `server/src/services/learning/pattern-miner-tick.ts` — production wire that loads recent runs, clusters them, calls the LLM to synthesize names, writes/updates `outcome_patterns`.
- Create: `server/src/services/learning/__tests__/pattern-miner-tick.test.ts`

Reuses the embedding provider config from Memory's reflection worker. Per-tick budget cap (`LEARNING_MAX_LLM_CALLS_PER_TICK`, default 10) prevents cost spikes. Tests mock the LLM + DB and verify the upsert-vs-evidence-extend behavior.

## Task 7: skill miner

**Files:**

- Create: `server/src/services/learning/skill-miner.ts`
- Create: `server/src/services/learning/__tests__/skill-miner.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts` — add `mineAgentSkills(opts)` stage.
- Create: `server/src/services/learning/skill-miner-tick.ts`

Pure: `extractSkillsFromRun(runSummary, llm) → string[]` (free-form skill names). Tick aggregates per (agent_id, skill_name) over the past 30 days; updates `confidence` + `last_evidenced_at`; applies decay for skills not evidenced in 90+ days. Tests cover: empty run summary → no skills; multi-skill aggregation; decay over a month; deletion when confidence drops below 0.05.

## Task 8: decision-pattern aggregator

**Files:**

- Create: `server/src/services/learning/decision-aggregator.ts`
- Create: `server/src/services/learning/__tests__/decision-aggregator.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts` — add `aggregateDecisionPatterns(opts)` stage.

Pure: `groupDecisionsByCondition(decisions, llm) → Group[]`. Production wire reads recent `plan_decisions`, normalizes (title + options + rationale), embeds for clustering, calls the LLM to synthesize `condition_summary` + `typical_choice`. Upserts `decision_patterns` rows.

## Task 9: suggestPlaybooks + heartbeat hook

**Files:**

- Create: `server/src/services/learning/suggest.ts`
- Create: `server/src/services/learning/__tests__/suggest.test.ts`
- Modify: `server/src/services/heartbeat.ts` — in `executeRun`, after the existing memory recall block, call `suggestPlaybooks` and prepend the top match(es) to `context.paperclipMemoryPreamble` if score > threshold.

`suggestPlaybooks(svc, ctx, issueContext) → Array<{playbook, score, reason}>` lists active playbooks for the company, scores each via the applicability matcher, returns top-N (default 3) sorted by score, filtered to score ≥ threshold (default 0.3, env-overridable). Tests cover: empty playbook list → []; 5 playbooks → top-3; score-threshold filter; tenant gate.

## Task 10: REST endpoints

**Files:**

- Create: `server/src/routes/learning.ts`
- Modify: `server/src/app.ts` — register.
- Create: `server/src/routes/__tests__/learning.test.ts`

Routes:
- `POST /api/companies/:cid/playbooks` create
- `GET /api/companies/:cid/playbooks` list (filter by status / agent_id)
- `GET /api/playbooks/:id` (with current revision)
- `POST /api/playbooks/:id/revisions`
- `POST /api/playbooks/:id/approve`
- `POST /api/playbooks/:id/archive`
- `GET /api/companies/:cid/outcome-patterns`
- `POST /api/outcome-patterns/:id/promote` → returns the new playbook id
- `GET /api/agents/:id/skills`
- `GET /api/companies/:cid/decision-patterns`
- `POST /api/companies/:cid/playbooks/suggest` (issueContext body) — direct query for the suggestion hot path, useful for plugin authors.

## Task 11: UI — `/admin/learning` curation page

**Files:**

- Create: `ui/src/pages/AdminLearning.tsx`
- Create: `ui/src/api/learning.ts`
- Modify: `ui/src/App.tsx` — register the route.

Sections: (1) proposed playbooks list with Approve / Edit / Discard buttons; (2) active playbooks list with Archive / Edit; (3) recent outcome patterns with Promote-to-Playbook; (4) recent decision patterns. Pollable + reuses existing admin layout.

## Task 12: UI — agent skills page

**Files:**

- Create: `ui/src/pages/AgentSkills.tsx`
- Modify: `ui/src/pages/AgentDetail.tsx` — add a Skills tab.

Lists skill_name + confidence bar + last-evidenced date + linked exemplar runs. Manual override button (delete a wrongly-derived skill).

## Task 13: UI — pattern dashboard

**Files:**

- Create: `ui/src/pages/LearningPatterns.tsx`

`/learning/patterns` (per-company): outcome patterns + decision patterns side-by-side; size + confidence indicators; click-through to exemplars.

## Task 14: prompt-prefix integration

**Files:**

- Modify: `server/src/services/heartbeat.ts` — extend the existing memory-prefix builder to include a "Suggested playbooks" section above the wiki / facts section. Format: `<playbook>...</playbook>` per match.

`buildMemoryPromptPrefix` (Memory Plan 1's prompt-prefix.ts) accepts an optional `playbooks: Array<{title, body, score}>` parameter and renders them at the top.

## Task 15: REST suggest hot path + caching

**Files:**

- Modify: `server/src/services/learning/suggest.ts` — add an in-memory LRU cache keyed on `(companyId, hash(issueContext))` with 60-second TTL. Hot-path runs hit the cache; admin curation triggers cache invalidation.
- Create: `server/src/services/learning/__tests__/suggest-cache.test.ts`

Cache size 1000 entries; LRU eviction. Tests cover hit / miss / TTL expiry / explicit invalidation.

## Task 16: OTel spans + metrics

**Files:**

- Create: `server/src/services/learning/spans.ts`
- Create: `server/src/services/learning/metrics.ts`
- Create: `server/src/services/learning/__tests__/spans.test.ts`
- Create: `server/src/services/learning/__tests__/metrics.test.ts`

Per spec's observability section: 4 span families + 5 metric streams. Same lazy-meter pattern as artifacts/metrics.ts and plans/metrics.ts.

## Task 17: end-to-end integration test

**Files:**

- Create: `server/src/services/learning/__tests__/integration.test.ts`

Embedded-postgres-backed flow: seed 5 similar completed runs across two companies, run one tick of `mineOutcomePatterns`, observe an `outcome_patterns` row at confidence ≥ 0.5, promote it to a playbook, approve, then `suggestPlaybooks` against a new matching issue context returns the playbook with score > threshold.

## Task 18: green build + ROADMAP

**Files:**

- Verify: `pnpm -r exec tsc --noEmit` clean.
- Verify: `pnpm test` clean per package.
- Modify: `ROADMAP.md` — flip Automatic Organizational Learning ⚪ → 🚧 with one-paragraph summary.

---

## Risks (operator-facing)

- **LLM cost.** Mining over 24h of runs across companies adds calls. Mitigation: per-tick LLM-call budget; admin UI shows projected cost.
- **Suggestion noise.** Low-confidence playbooks suggested too eagerly. Mitigation: configurable score threshold + per-suggest histogram for tuning.
- **Privacy.** Cross-issue clustering surfaces internal info. Mitigation: per-company isolation enforced at every read; MCP read scopes (Plan 2).
- **Skill staleness.** Pivoted agents stop matching old skills. Mitigation: 90-day decay + manual override.
- **Backwards compatibility.** All learning surfaces are additive; absence of playbooks doesn't change run behavior. Threshold-gated suggestion never replaces existing memory recall.

---

*Draft: 2026-05-15. Builds on the org-learning spec dated 2026-05-15. Ready to execute task-by-task.*
