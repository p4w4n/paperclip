# Deep Planning Design

> Spec for the **Deep Planning** roadmap milestone. Grounded in the May 2026 state-of-the-art (Anthropic Claude Plan Mode, OpenAI Deep Research, Cursor Composer 2 implementation plans, Devin's PR-plan surface, LangGraph plan-and-execute, Linear initiatives). Plan document follows once review lands.

## Problem

Paperclip agents execute against issues directly. For routine work (fix a bug, add a small feature) that's the right shape — issue is the unit, run is the action, done. For *strategy-heavy* work — a multi-week refactor, an exploratory architecture decision, a research initiative — there's a missing layer: the plan itself.

Today's failure modes:

- An operator opens an issue "rewrite the auth stack." The agent picks it up, makes 30% of the right decisions and 70% of plausible-but-wrong ones, then 8 hours of work has to be unwound.
- An issue accretes 50 comments as the agent and humans hash out approach in-thread. There's no canonical "this is the plan we agreed on" surface.
- A complex feature spawns 12 sub-issues. There's no parent that holds the *why* — just a tree of *what*.
- Halfway through, requirements shift. Re-aligning means rebuilding the agent's context from scratch through more comments.

The 2026 industry consensus is **plan-then-execute as a first-class loop**: agents propose a structured plan, humans (or other agents) review and revise, and only then does execution start. Anthropic's Plan Mode, Cursor Composer 2's "implementation plans," Devin's PR-plan surface, and LangGraph's plan-and-execute pattern all implement variations of this. Paperclip needs the same primitive — and because we already have memory, artifacts, and work queues, we can wire planning into all three from day 1.

## Goals

1. A `plans` layer attached to issues, holding the agreed approach + decision rationale + phase breakdown for strategy-heavy work.
2. **Versioned revisions** with diff view — plans evolve as understanding does; each revision tracks what changed + why, with `parent_revision_id` chaining (same shape as document_revisions and memory_pages).
3. **Phases** — a plan decomposes into ordered phases (typically Research → Design → Implementation → Validation, but the shape is operator-defined). Each phase has its own exit criteria, started_at, completed_at, and links to the runs that executed it.
4. **Review surface** — humans + agents can request changes / approve a plan revision. Approval is the gate that lets execution start; revisions made mid-execution can re-trigger review.
5. **Execution integration** — phases produce work-queue items (Plan 1 of Work Queues) which materialize into runs; phases gate on prior phase completion + reviewer approval per a configurable policy.
6. **Decision records** — explicit "we considered A, B, C; chose B because…" rows so future reviewers (and Memory's reflection worker) can see the rationale instead of having to re-derive it from comments.
7. **Memory integration** — completed plans become organizational knowledge: the reflection worker (M-12+) ingests their content into wiki pages so future planning starts from the existing canon.
8. **Artifact integration** — research notes, design diagrams, prototypes attach as Artifacts (Plan 1 of Artifacts), preserved with the plan.

## Non-goals (v1)

- **Gantt-chart / timeline view.** Phases have order + dependencies but no calendar-grain scheduling. Linear / Plane already do this; out of scope.
- **Resource allocation / capacity planning.** Doesn't track agent hours, cost projections, or capacity. Plan = intent + structure, not budgeting.
- **Plan templates / library.** Operators write plans freehand in v1. Templated initialization can land in Plan 2 (e.g., "use the standard refactor template").
- **Cross-issue / cross-company plan federation.** A plan attaches to one issue (within one company). Multi-issue rollups stay in the existing relations table.
- **AI-driven plan critique scoring.** v1's review surface is structured comments + approval. Auto-grading the plan's quality is a separate concern.
- **Real-time collaborative editing.** Plans are revisioned snapshots, not CRDTs (matches artifacts + memory).

## Architecture

```
┌──────────────────┐
│   issue          │
│   (existing)     │
└────────┬─────────┘
         │ 1:1 (optional)
         ▼
┌──────────────────────────────────┐
│  plan                            │
│  (status: draft|under_review|    │
│   approved|in_progress|completed)│
│  current_revision_id ────────┐   │
└─────────────┬────────────────┘   │
              │                    │
              │ 1:N                ▼
              │           ┌──────────────────────┐
              │           │ plan_revision        │
              │           │ (markdown body,      │
              │           │  parent_revision_id) │
              │           └──────────────────────┘
              │
              │ 1:N (ordered)
              ▼
     ┌──────────────────┐
     │  plan_phase      │
     │  (status, exit   │
     │   criteria,      │
     │   ordering)      │
     │                  │
     │  current_phase_  │
     │   revision_id    │
     └─────┬────────────┘
           │ DAG
           ▼
     ┌──────────────────┐
     │ plan_phase_      │
     │ dependencies     │
     │ (from, to)       │
     └──────────────────┘

     ┌──────────────────┐    ┌──────────────────┐
     │ plan_review      │    │ plan_decision    │
     │ (decision,       │    │ (title, options, │
     │  reviewer)       │    │  chosen, ratio…) │
     └──────────────────┘    └──────────────────┘

     [phase] ─── work_queue.enqueue ───► work_items ───► heartbeat_runs
                 (Plan 1 of Work Queues)        (existing)
```

### Schema

```sql
-- The container.
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
    -- 'draft'|'under_review'|'approved'|'in_progress'|'completed'|'cancelled'
  current_revision_id UUID,
  current_revision_number INT NOT NULL DEFAULT 1,
  -- Approval policy: who must approve before execution can start.
  -- 'one_human' | 'all_assignees' | 'agent_only' | 'none'.
  approval_policy TEXT NOT NULL DEFAULT 'one_human',
  -- Optional execution policy: when a phase completes, who decides
  -- the next phase starts. 'auto' (run if all gates pass) or
  -- 'manual' (operator clicks Start).
  phase_advance_policy TEXT NOT NULL DEFAULT 'auto',
  created_by_user_id TEXT,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX plans_company_status_idx ON plans (company_id, status);
CREATE INDEX plans_issue_idx ON plans (issue_id);

-- Versioned revisions. Snapshot+parent like memory_pages /
-- document_revisions. Diffs derived lazily.
CREATE TABLE plan_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  parent_revision_id UUID REFERENCES plan_revisions(id) ON DELETE SET NULL,
  content_markdown TEXT NOT NULL,
  change_summary TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
    -- 'proposed' | 'approved' | 'rejected' | 'superseded'
  created_by_user_id TEXT,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plan_revisions_plan_revnum_uniq
  ON plan_revisions (plan_id, revision_number);

-- Phases. A plan has 1..N phases with explicit ordering. The DAG
-- table below lets phases be parallel where appropriate; ordering
-- is the linearization, dependencies are the DAG.
CREATE TABLE plan_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  ordering INT NOT NULL,           -- monotone-stable; UI sort key
  name TEXT NOT NULL,
  description_markdown TEXT,
  exit_criteria_markdown TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending'|'ready'|'in_progress'|'completed'|'skipped'|'blocked'
  assignee_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX plan_phases_plan_idx ON plan_phases (plan_id, ordering);

-- Phase DAG. (from_phase, to_phase) means to_phase blocks on
-- from_phase completion.
CREATE TABLE plan_phase_dependencies (
  from_phase_id UUID NOT NULL REFERENCES plan_phases(id) ON DELETE CASCADE,
  to_phase_id   UUID NOT NULL REFERENCES plan_phases(id) ON DELETE CASCADE,
  PRIMARY KEY (from_phase_id, to_phase_id)
);

-- Reviews. Decisions stamp a specific revision, not the plan as a
-- whole — re-revising re-triggers review per the policy.
CREATE TABLE plan_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES plan_revisions(id) ON DELETE SET NULL,
  reviewer_user_id TEXT,
  reviewer_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,          -- 'approved' | 'requested_changes' | 'rejected'
  comment_markdown TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_reviews_plan_idx ON plan_reviews (plan_id, created_at DESC);

-- Decision records. Plan-level rationale capture: "we considered
-- A, B, C; chose B because…". Distinct from review comments —
-- decisions are durable artifacts of the plan, reviews are
-- transient review-cycle state.
CREATE TABLE plan_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase_id UUID REFERENCES plan_phases(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  options_json JSONB NOT NULL,     -- [{"id": "a", "label": "use postgres"}, …]
  chosen_option_id TEXT NOT NULL,
  rationale_markdown TEXT,
  decided_by_user_id TEXT,
  decided_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by_id UUID REFERENCES plan_decisions(id) ON DELETE SET NULL
);

-- Phase ↔ run linkage. A phase may have many runs; a run may
-- belong to at most one phase.
CREATE TABLE plan_phase_runs (
  phase_id UUID NOT NULL REFERENCES plan_phases(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
  PRIMARY KEY (phase_id, run_id)
);
```

### Service contract

```ts
interface PlanService {
  createPlan(ctx, input: { issueId?: string; title: string;
    initialContent: string; phases?: PhaseDraft[] }): Promise<Plan>;
  reviseplan(ctx, planId: string, input: { contentMarkdown: string;
    changeSummary: string }): Promise<PlanRevision>;
  submitReview(ctx, planId: string, decision: 'approved' |
    'requested_changes' | 'rejected', comment?: string): Promise<void>;
  startPhase(ctx, phaseId: string): Promise<void>;
  completePhase(ctx, phaseId: string,
    exitCriteriaMet: boolean): Promise<void>;
  recordDecision(ctx, planId: string, input: DecisionInput): Promise<PlanDecision>;
  enqueuePhaseWork(ctx, phaseId: string): Promise<{ workItemId: string }>;
  forget(ctx, planId: string): Promise<void>;
}
```

### Lifecycle and states

```
[create] ─────► draft ─────► under_review ────► approved
                  │              │     │           │
                  │              │     ▼           ▼
                  │              │  rejected    in_progress ───► completed
                  │              │                  │
                  │              ▼                  │
                  ▼          (re-revise              ▼
              cancelled        → review)         (phase loop)
```

Plan-level: draft → under_review → approved → in_progress → completed (or rejected / cancelled at any pre-progress point).

Phase-level: pending → ready (when deps complete) → in_progress (when started) → completed (when exit criteria met) | skipped | blocked.

A plan revision mid-execution moves the plan back to under_review **only if** the policy says so (some operators want fast iteration without re-approval; others want every change re-approved). Configurable per plan.

### Agent integration

Two paths agents interact with plans:

**A. Plan-author agent.** A "planner" agent role is invoked when an issue is too large for direct execution. It produces an initial plan revision, optionally with proposed phases. Memory recall (Plan 1 of Memory) feeds the planner agent the relevant wiki pages on the topic so it doesn't re-derive the canon.

**B. Phase-execution agent.** Each phase optionally has an `assignee_agent_id`. When a phase enters `ready`, the phase service calls `workQueue.enqueue({ routineId: …, payload: { planId, phaseId } })` — the phase produces work-queue items, which materialize into runs (Plan 1 of Work Queues), and those runs are tracked back via `plan_phase_runs`. The agent reads the plan revision + phase brief from the run's `contextSnapshot.planContext` field.

### Memory integration

When a plan completes, the Memory reflection worker ingests:

- The final plan revision → a wiki page (kind: `procedural`, "How we did the auth refactor").
- Each `plan_decision` → a semantic memory entry (kind: `semantic`, the rationale).
- Significant artifact references (research notes, design docs) → linked from the wiki page.

This closes the loop: future plans on similar topics start with the wiki page automatically prepended via the existing `<memory>` prompt-prefix.

### Artifact integration

Research notes, design diagrams, prototypes produced during phases are declared as Artifacts (Plan 1 of Artifacts) with the plan id in `content_meta.plan_id`. The plan detail UI reads them via `GET /api/plans/:id/artifacts`.

### Observability

OTel spans:
- `paperclip.plan.create`
- `paperclip.plan.revise`
- `paperclip.plan.review_decision` (attribute: decision = approved|requested_changes|rejected)
- `paperclip.plan.phase.start` / `paperclip.plan.phase.complete`
- `paperclip.plan.decision.record`

Metrics:
- `paperclip_plans_active{company,status}` gauge
- `paperclip_plan_revisions_per_plan` histogram
- `paperclip_plan_review_decisions_total{decision}` counter
- `paperclip_plan_phase_duration_ms{name}` histogram (completed_at - started_at)
- `paperclip_plan_decisions_total{plan_id}` counter

UI: an "Plan" tab on issue detail shows the current revision, phase tree, decision log, and review surface. A separate `/plans` index page lists in-flight plans across the company.

## Failure modes

| Failure | Behavior |
|---|---|
| Reviewer approves an old revision | The approval is stamped with the revision_id; if a newer revision exists the plan stays in `under_review` until a fresh approval lands. |
| Phase circular dependency | Server-side validation: when adding to plan_phase_dependencies, run a cycle-check via recursive CTE; reject the link with 422. |
| Plan deleted mid-execution | Cascade to plan_revisions / plan_phases / plan_reviews / plan_decisions. Active runs (heartbeat_runs) are NOT deleted — they live their own lifecycle and get linked-but-orphan via plan_phase_runs ON DELETE CASCADE. |
| Phase agent fails three times | Standard work-queue retry policy applies (Plan 1 of Work Queues); after exhaustion phase moves to `blocked`. Operator decides next step (skip / re-plan / cancel). |
| Two reviewers race to approve | Postgres serializes; both rows commit, plan moves to approved on the first; second sees latest_revision_already_approved and is treated as a re-confirmation. |
| Plan that never completes | Surface in the dashboard as "stale" if no revision / decision in 30 days. Operators decide to nudge / cancel. |

## Phasing

1. **Schema + service contract.** plans, plan_revisions, plan_phases, plan_phase_dependencies, plan_reviews, plan_decisions, plan_phase_runs.
2. **CRUD + revision chain.** create / revise / get current revision / list revisions.
3. **Review surface.** submit review; auto-transition plan status on approval per policy.
4. **Phase lifecycle.** start / complete / skip; exit-criteria gating via the markdown checklist.
5. **Phase ↔ work-queue integration.** enqueuePhaseWork + the run-linkage table.
6. **Decision records.** record / list / supersede.
7. **Memory hook.** on plan completion, surface a `procedural` wiki page + semantic facts (depends on Plan 1 of Memory).
8. **Artifact tagging.** plan_id in artifact content_meta + the GET /api/plans/:id/artifacts route.
9. **UI: plan tab + /plans index.** revision diff view, phase tree, decision log, review surface.
10. **OTel spans + metrics.** Per the observability section.

Phases 1-5 deliver the core plan loop; 6-10 are quality-of-life and integration.

## Risks

- **Adoption.** If operators don't reach for plans, they're dead weight. Mitigation: agents proactively suggest "this looks like it needs a plan" when an issue's title matches certain patterns (multi-week work, "rewrite", "refactor", "architecture"). Plan 2 explores templated initialization.
- **Plan vs comments.** Operators may comment on the issue when they should be revising the plan. Mitigation: surface a banner on the issue once a plan exists ("Discussion happens on the plan; comments here are operational only"). Hard to enforce; cultural change.
- **Reviewer fatigue.** Plans with 12 revisions before approval burn reviewer time. Mitigation: track time-in-review per plan as a metric; alert when median exceeds a threshold so operators can refine the policy.
- **Phase-DAG complexity.** A plan with 30 phases in a complex DAG becomes unreadable. Mitigation: cap phases at 10 in the UI by default with an "expand" toggle; recommend grouping into sub-plans (issue → child issues) when bigger.
- **Stale plans.** Plans that never complete clutter the dashboard. Mitigation: stale-detection sweep (30-day quiescence flag).

## Decisions

- **Plan = first-class table, not a doc revision flavor.** Plans have lifecycle, phases, decisions — too much structure to live as `documents.kind = 'plan'`.
- **Phase DAG, not strict order.** Real plans have parallel research / parallel-implementable pieces. Linear order is too restrictive; full graph-of-graphs is overkill.
- **Reviews stamp revisions, not plans.** Re-revision retriggers review per policy. Mirrors GitHub PR review behavior.
- **Decisions are durable, reviews are transient.** Reviews are the *process* of getting to a decision; the decision itself is the artifact worth preserving.
- **Memory + Artifacts integration from day 1.** The whole point is closing the loop: planning informed by past plans, future plans informed by this one.

## Notes on deferred concerns

- **Plan templates.** Operators write plans freehand in v1. Templated initialization ("standard refactor template") lands in Plan 2.
- **Capacity / cost projections.** Out of scope — see Linear / Plane.
- **Cross-issue rollups.** A plan attaches to one issue. Multi-issue summary views can be a Plan 2 dashboard.
- **Real-time collab.** Snapshot+parent revisions, not CRDT. Same call as artifacts + memory.

## Open questions

1. **Default approval_policy.** `one_human` is the safe default but slower. Should agent-only plans (auto-approve via a planner-validator agent pair) be a separate policy or just `one_human` with the validator agent as the human?
2. **Phase parallelism limits.** Should there be a max-concurrent-phases knob per plan? Useful for cost control; adds yet another concurrency primitive.
3. **Plan archival.** Completed plans live forever — useful for memory ingestion but eventually clutter. Auto-archive at N years configurable per company?
4. **Issue without plan.** When does an issue NOT need a plan? Operators may want to mark issues as "no plan needed" so the UI doesn't pester. Boolean column or omission?
5. **Plan-author agent default.** Which agent role runs the initial plan generation? Likely a new `planner` adapter type — Plan 2 concern.

---

*Draft: 2026-05-15. Review with: spec author + UX lead + planning-agent reviewer. Plan document follows once the open questions resolve.*
