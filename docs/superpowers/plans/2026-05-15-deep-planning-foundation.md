# Deep Planning Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-15-deep-planning-design.md`. This plan delivers: the `plans` + `plan_revisions` + `plan_phases` + `plan_phase_dependencies` + `plan_reviews` + `plan_decisions` + `plan_phase_runs` tables, the `PlanService` write/revise/review/phase path with tenant isolation, the phase ↔ work-queue integration that enqueues phase work + the run-linkage table, decision records, memory + artifact integration hooks, the `Plan` tab on issue detail + the `/plans` index page, OTel spans + metrics.

**Architecture:** New `server/src/services/plans/` module owns the contract + default Postgres-native implementation. Plan-level transitions (draft → under_review → approved → in_progress → completed) are gated by a configurable `approval_policy`. Phases are a DAG: `plan_phase_dependencies` lets phases be parallel where appropriate; the linearization (`ordering`) is just the UI sort key. Phase-level transitions (pending → ready → in_progress → completed) gate on dep completion + (optionally) reviewer approval. When a phase is started, the service calls `WorkQueueService.enqueue` (Plan 1 of Work Queues) with `routineId=null, payload={planId, phaseId}` and registers a routine-materializer that turns the phase into the `(issueId, agentId)` the run targets. On run completion, the connect-handler updates `plan_phase_runs` + the phase status.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres). Builds on Memory (Plan 1), Artifacts (Plan 1), and Work Queues (Plan 1) all already in master.

**Scope split (this plan covers Plan 1 of 2 for deep planning):**

- ✅ This plan: schema + service contract; CRUD + revision chain; review surface; phase lifecycle; phase ↔ work-queue integration; decision records; memory + artifact hooks; UI plan tab + /plans index; OTel spans + metrics.
- ⏭ Plan 2: plan templates / library; planner-agent role; phase parallelism caps; auto-archival; cross-issue rollup dashboard; agent-driven plan critique scoring; multi-plan composition (parent plan → child sub-plans).

---

## File Structure

**Created:**

- `packages/db/src/schema/plans.ts` — Drizzle schema for the plan container.
- `packages/db/src/schema/plan_revisions.ts` — versioned revisions.
- `packages/db/src/schema/plan_phases.ts` — phase rows.
- `packages/db/src/schema/plan_phase_dependencies.ts` — DAG edges.
- `packages/db/src/schema/plan_reviews.ts` — review decisions.
- `packages/db/src/schema/plan_decisions.ts` — durable decision records.
- `packages/db/src/schema/plan_phase_runs.ts` — phase ↔ run linkage.
- `packages/db/src/migrations/0088_deep_planning_foundation.sql` — DDL with the unique on (plan_id, revision_number) and the cycle-prevention check (no SQL constraint; service-layer validation).
- `server/src/services/plans/types.ts` — `PlanService` contract; `Plan` / `PlanRevision` / `PlanPhase` / `PlanReview` / `PlanDecision` shapes; `PlanTenantMismatchError`.
- `server/src/services/plans/service.ts` — in-process service.
- `server/src/services/plans/revisions.ts` — pure helpers for the revision chain.
- `server/src/services/plans/cycle-check.ts` — pure DAG cycle-detector.
- `server/src/services/plans/lifecycle.ts` — pure state-transition validator.
- `server/src/services/plans/phase-ready.ts` — pure: given phase deps + their statuses, return whether a phase is "ready".
- `server/src/services/plans/queue-bridge.ts` — wires phase start → workQueue.enqueue + the routine-materializer that turns phaseId into (issueId, agentId).
- `server/src/services/plans/memory-ingest.ts` — on plan completion, calls memory.upsertPage + memory.write per spec.
- `server/src/services/plans/spans.ts` — OTel span helpers.
- `server/src/services/plans/metrics.ts` — OTel metrics.
- `server/src/services/plans/__tests__/*.test.ts` — one per module above.
- `server/src/routes/plans.ts` — REST: CRUD, revise, review, phase start/complete, decision record, list-by-issue, list-active.
- `ui/src/api/plans.ts` — UI client.
- `ui/src/features/issues/plan-tab/PlanTab.tsx` — issue-detail Plan tab.
- `ui/src/features/issues/plan-tab/PhaseTree.tsx` — phase-DAG renderer.
- `ui/src/features/issues/plan-tab/RevisionDiff.tsx` — markdown diff between two revisions.
- `ui/src/features/issues/plan-tab/DecisionLog.tsx` — durable decisions list.
- `ui/src/features/issues/plan-tab/ReviewSurface.tsx` — approve / request-changes / reject controls.
- `ui/src/pages/Plans.tsx` — `/plans` index page across the company.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export the new tables.
- `server/src/services/work-queue/routine-integration.ts` — when payload has `planId`+`phaseId`, route through the plan-service's phase resolver.
- `server/src/index.ts` — initialize PlanService, wire memory-ingest hook on plan-completion.
- `server/src/services/heartbeat.ts` — on a heartbeat_run terminal transition, if the run was linked to a plan_phase, fire the phase's run-completion hook (which may auto-complete the phase per its exit criteria).
- `server/src/app.ts` — register `plansRoutes`.
- `ui/src/pages/IssueDetail.tsx` — add the Plan tab.
- `ui/src/App.tsx` — add the `/plans` route.
- `ROADMAP.md` — flip Deep Planning ⚪ → 🚧 in W-18.

**Migration:** `0088_deep_planning_foundation.sql`. All seven tables + the unique on `(plan_id, revision_number)`. No partial indexes needed in v1 (revision uniqueness is total, not partial). Generated via drizzle-kit; the only hand-edit is the file rename + journal entry.

---

## Conventions used in this plan

Same as the previous Tier-1 plans (memory, artifacts, work-queues):

- **Test framework:** Vitest. Single file: `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate`, then rename + update `meta/_journal.json`.
- **Commit style:** conventional commits matching existing history. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: schema + migration

**Files:**

- Create: 7 schema files in `packages/db/src/schema/plan_*.ts`.
- Create: `packages/db/src/migrations/0088_deep_planning_foundation.sql`.
- Modify: `packages/db/src/schema/index.ts` — re-export.

Per the spec's DDL exactly. Single hand-edit: rename the auto-named migration + journal entry. No partial indexes (precedent: 0085 artifacts didn't have any either; 0084 / 0087 did because they had supersession or queue-state filtering).

Verify: `pnpm --filter @paperclipai/db test src/client.test.ts`.

## Task 2: PlanService contract (types)

**Files:**

- Create: `server/src/services/plans/types.ts`
- Create: `server/src/services/plans/__tests__/types.test.ts` (smoke-tests the error class)

Mirrors the spec's TypeScript service interface. `PlanTenantMismatchError` shape matches the other Tier-1 services.

## Task 3: revision chain helper

**Files:**

- Create: `server/src/services/plans/revisions.ts`
- Create: `server/src/services/plans/__tests__/revisions.test.ts`

Pure: `nextRevisionNumber(rows)`, `currentRevision(rows)`, `revisionDiff(prev, next) → string` (line-level markdown diff for the UI). Tests cover empty / single / chain / unordered inputs.

## Task 4: cycle-check

**Files:**

- Create: `server/src/services/plans/cycle-check.ts`
- Create: `server/src/services/plans/__tests__/cycle-check.test.ts`

Pure: `wouldCreateCycle(existingEdges, newEdge)` — DFS from new.to following existing edges; if we reach new.from, cycle. Tests cover trivial / chained / parallel / cycle / self-cycle.

## Task 5: lifecycle validator

**Files:**

- Create: `server/src/services/plans/lifecycle.ts`
- Create: `server/src/services/plans/__tests__/lifecycle.test.ts`

Pure: `validatePlanTransition(from, to)` and `validatePhaseTransition(from, to)`. Map of allowed transitions; rejects illegal ones with a clear error code. Tests cover every legal + a sample of illegal transitions.

## Task 6: phase-ready check

**Files:**

- Create: `server/src/services/plans/phase-ready.ts`
- Create: `server/src/services/plans/__tests__/phase-ready.test.ts`

Pure: `phaseReadiness({ phase, deps, depStatuses })` — returns 'ready' iff all deps are completed; 'pending' if any dep is not yet completed; 'blocked' if any dep is skipped/cancelled-without-completion (plan-author has to fix the DAG). Tests cover all branches.

## Task 7: PlanService default impl

**Files:**

- Create: `server/src/services/plans/service.ts`
- Create: `server/src/services/plans/__tests__/service.test.ts`

In-process implementation. `createPlan` writes plan + initial revision in one tx. `revisePlan` inserts a new revision row, bumps `current_revision_id` + `current_revision_number`, transitions plan to `under_review` if approval policy requires re-review (per the spec's policy table). `submitReview` writes the review row; on `approved` AND quorum-met, transitions plan to `approved`; on `requested_changes` keeps plan in `under_review`. `startPhase` validates dep readiness via phase-ready helper, transitions to `in_progress`. `completePhase` validates exit-criteria checkbox completion. `recordDecision` writes the decision row. `forget` cascades. Tenant-gate on every method.

## Task 8: REST endpoints

**Files:**

- Create: `server/src/routes/plans.ts`
- Modify: `server/src/app.ts` — register.
- Create: `server/src/routes/__tests__/plans.test.ts`

Routes:
- `POST /api/issues/:issueId/plans` create
- `GET /api/plans/:id` get current revision
- `GET /api/plans/:id/revisions` list
- `POST /api/plans/:id/revisions` revise
- `POST /api/plans/:id/reviews` submit review
- `POST /api/plans/:id/phases/:phaseId/start`
- `POST /api/plans/:id/phases/:phaseId/complete`
- `POST /api/plans/:id/decisions` record
- `GET /api/companies/:cid/plans` index (filterable by status)

Tenant: derive companyId from the issue or plan row + assertCompanyAccess + service-layer assertTenant.

## Task 9: phase ↔ work-queue integration

**Files:**

- Create: `server/src/services/plans/queue-bridge.ts`
- Create: `server/src/services/plans/__tests__/queue-bridge.test.ts`
- Modify: `server/src/services/work-queue/routine-integration.ts` — when payload has `planContext`, the routine-materializer routes to the plan service's phase resolver.

`enqueuePhaseWork(svc, { planId, phaseId })` calls `WorkQueueService.enqueue` with payload carrying `{planContext: {planId, phaseId}}`, `enqueuedByKind='api'`, dedupeKey=`plan-${planId}-phase-${phaseId}-attempt-N`. On dequeue the routine-materializer hits `resolvePhaseTarget(planId, phaseId)` which returns `(issueId, assigneeAgentId)` from the phase row. The phase's `started_at` is set + the work_item run_id is captured into `plan_phase_runs` after the run is materialized.

## Task 10: memory ingestion hook

**Files:**

- Create: `server/src/services/plans/memory-ingest.ts`
- Create: `server/src/services/plans/__tests__/memory-ingest.test.ts`

`ingestCompletedPlan(planId)` runs once when a plan transitions to `completed`. It calls `memory.upsertPage` with kind 'procedural' (the plan's final revision content + a "Completed plan: ${title}" header) and writes one `memory.write({kind: "semantic"})` per `plan_decision`. Tests mock the memory service.

## Task 11: artifact integration

**Files:**

- Modify: `server/src/services/artifacts/service.ts` — accept optional `content_meta.plan_id` validated against the plan kind registry.
- Create: `server/src/routes/plans-artifacts.ts` — `GET /api/plans/:id/artifacts` proxies to artifacts service filtered on `content_meta->>'plan_id' = :id`.
- Create: `server/src/routes/__tests__/plans-artifacts.test.ts`

Artifacts already accept a free-form `content_meta`. The plan integration is just a discovery query + UI affordance.

## Task 12: heartbeat run-completion → phase update

**Files:**

- Modify: `server/src/services/heartbeat.ts` — in the existing terminal-transition handler, if the run is linked via `plan_phase_runs`, fire `planService.onRunCompletedForPhase(phaseId, runId, terminalState)`.
- Create: `server/src/services/plans/__tests__/run-completion-hook.test.ts`

`onRunCompletedForPhase` reads the phase's exit_criteria_markdown checkboxes; if the agent's run summary marked them all checked, auto-completes the phase. Otherwise stays in `in_progress`.

## Task 13: OTel spans + metrics

**Files:**

- Create: `server/src/services/plans/spans.ts`
- Create: `server/src/services/plans/metrics.ts`
- Create: `server/src/services/plans/__tests__/{spans,metrics}.test.ts`

Per spec: `paperclip.plan.{create,revise,review_decision,phase.start,phase.complete,decision.record}` spans + the 5 metric streams.

## Task 14: UI Plan tab — phase tree + revision view

**Files:**

- Create: `ui/src/api/plans.ts`
- Create: `ui/src/features/issues/plan-tab/PlanTab.tsx`
- Create: `ui/src/features/issues/plan-tab/PhaseTree.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx` — register the Plan tab.

PlanTab renders the current revision's markdown + the phase tree. PhaseTree shows phases in `ordering` order with dep arrows; per-phase status pill; "Start" / "Complete" buttons gated on policy + readiness. Conditional render gated on `detailTab === "plan"` so the fetch only fires when the user opens the tab.

## Task 15: UI revision diff + decision log

**Files:**

- Create: `ui/src/features/issues/plan-tab/RevisionDiff.tsx`
- Create: `ui/src/features/issues/plan-tab/DecisionLog.tsx`
- Modify: `ui/src/features/issues/plan-tab/PlanTab.tsx` — wire the panels.

RevisionDiff: dropdown to pick prev / next revision; markdown diff via the existing diff-md helper. DecisionLog: list of decisions with the chosen option highlighted, expandable to show options + rationale.

## Task 16: UI review surface + /plans index page

**Files:**

- Create: `ui/src/features/issues/plan-tab/ReviewSurface.tsx`
- Create: `ui/src/pages/Plans.tsx`
- Modify: `ui/src/App.tsx` — add `/plans` route.

ReviewSurface: textarea + Approve/RequestChanges/Reject buttons; gated on `req.actor` having reviewer role per the plan's approval_policy. Plans index: filterable list of plans across the company; reuses the existing dashboard primitives.

## Task 17: routine-trigger refactor — opt-in plan-required flag

**Files:**

- Modify: `packages/db/src/schema/routines.ts` — add `requires_plan BOOLEAN NOT NULL DEFAULT false`.
- Migration extension: append the column to 0088 (or follow-up migration if 0088 has shipped).
- Modify: `server/src/services/routines.ts` — when a routine fires AND `requires_plan=true`, the firing produces a *plan* (status='draft') instead of a direct run. The plan's first phase is the routine's normal materialize() output — handed off to the existing path once the plan is approved.

This is the operator surface for "this scheduled work requires a plan first" — useful for weekly research routines, monthly review cycles, etc.

## Task 18: green build + ROADMAP

**Files:**

- Verify: `pnpm -r exec tsc --noEmit` clean.
- Verify: `pnpm test` clean per package.
- Modify: `ROADMAP.md` — flip Deep Planning ⚪ → 🚧 with one-paragraph summary.

End-to-end smoke test: an integration test creates a plan with two phases, revises it, submits an approval review, starts phase 1, completes it, observes phase 2 transitioning to ready, completes phase 2, observes the plan transitioning to completed + the memory-ingest hook firing.

---

## Risks (operator-facing)

- **Adoption drag.** If operators don't reach for plans, they're dead weight. Mitigation: when an issue's title matches certain heuristics ("rewrite", "refactor", "architecture", multi-week language), the heartbeat suggests "this looks like it needs a plan" — UI banner with one-click create.
- **Plan vs comments.** Operators may keep commenting on the issue when they should be revising the plan. Mitigation: surface a banner once a plan exists; cultural change over enforcement.
- **Reviewer fatigue.** 12 revisions before approval burns reviewer time. Mitigation: track time-in-review as a metric; alert when median exceeds threshold.
- **Phase-DAG complexity.** 30-phase plans become unreadable. Mitigation: cap at 10 in the UI by default; recommend grouping into sub-plans (parent issue → child issues with their own plans).
- **Backwards compatibility.** Existing issues without plans keep working unchanged. Plans are opt-in; the absence of a plan doesn't change any existing behavior.

---

*Draft: 2026-05-15. Builds on the deep-planning spec dated 2026-05-15. Ready to execute task-by-task.*
