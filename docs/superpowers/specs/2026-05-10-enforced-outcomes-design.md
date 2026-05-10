# Enforced Outcomes Design

> Spec for the **Enforced Outcomes** roadmap milestone. Builds on five already-landed Tier-1 substrates: Memory (Plan 1), Artifacts (Plan 1), Work Queues (Plan 1), Deep Planning (Plan 1), and Automatic Organizational Learning (Plan 1). The point is to make Paperclip strict about *what counts as finished work* — terminal-state transitions on issues and plans require a verified outcome when an opt-in contract says so. Plan document follows once open questions resolve.

## Problem

Today, completion in Paperclip is a status-field flip. `issues.status = "done"`, `plans.status = "completed"`, `plan_phases.status = "completed"` (with `exit_criteria_markdown` checkboxes that nobody verifies), `work_items.state = "succeeded"`. The `approvals` table from the "Agent Reviews and Approvals" milestone exists but is decorative — approvals are recorded next to the issue, not in the path of its completion.

That gap shows up in concrete ways:

- An issue says "ship the auth refactor" — agent marks it `done`, but no PR ever merged. The status flip is the only signal anyone has.
- A plan completes with three of seven phases marked `completed` and four `skipped`. The `skipped` rows have no explanation; the plan still flows to `completed` status. There's no contract that says "this plan must produce a code-patch artifact and an approval before it can complete."
- A routine fires nightly to "review yesterday's incidents." The agent posts a comment and closes the issue. There's no record of a decision, no artifact, nothing future runs can grep for. Org Learning's pattern miner can see the run happened but can't tell if it succeeded.
- A `code.patch` artifact is declared by the worker. Two days later the PR is reverted upstream. Nothing in Paperclip notices — the issue stays `done`, the artifact stays "the deliverable."

The 2026 industry pattern for this is **outcome contracts**: declare up-front what counts as finished, verify outcomes against that contract, gate terminal transitions on verification. Stripe's idempotent webhook ingestion, Temporal's "complete-only-when-side-effect-confirmed" pattern, and the Linear/Asana "exit criteria" surfaces are all variations on the same idea. None of them are a perfect fit for Paperclip — Paperclip already has artifacts, plans, decisions, and approvals; the outcome layer needs to *observe* those substrates without owning them.

## Goals

1. A typed, contract-driven `outcomes` substrate — one row per required outcome on a gated entity (issue or plan), with status `pending → verified → reverted` and per-kind `required_meta` validated against a JSON schema.
2. **Seven outcome kinds** in Plan 1 covering all four roadmap examples (merged code via `external_signal`, published artifacts via `artifact_declared`, shipped docs via `artifact_declared` with `doc.*` kind, explicit decisions via `decision_recorded`) plus three additional verifier paths (`plan_completed`, `approval_granted`, `exit_criteria_met`, `manual_signoff`).
3. **Hard gate when required, no-op when not.** Issues and plans without a contract behave exactly as today. Issues and plans with a contract reject the terminal-state transition (`422 OutcomeRequiredError`) until every required outcome reaches `verified`.
4. **Hybrid verification protocol** — internal kinds verify by subscribing to events that already fire from the four landed substrates (no polling, no extra worker tick). External kinds verify via HMAC-signed webhook with Stripe-style idempotency. Manual sign-off is operator-driven via UI.
5. **Sticky terminals + audit reversion.** A verified outcome can flip to `reverted` (e.g., the PR was reverted, the approval rescinded). The parent issue/plan stays in its terminal state and the reversion lands as an audit-log entry — no automatic reopening in Plan 1.
6. **Substrate decoupling.** Outcomes never read or write the four landed substrates' tables. They subscribe to in-process events that the substrates already emit on commit. Disabling Outcomes (boot flag off) is a no-op for everyone else.
7. **Routine-level contracts.** Recurring work (the main "ops sets strict standards once" path) inherits a `default_required_outcomes` contract from its routine. Without this, every issue would need a manual contract write — a non-starter for adoption.

## Non-goals (v1)

- **Provider-specific webhook adapters.** No GitHub-app PR-merged adapter, no GitHub-Actions CI-pass adapter, no Linear-issue-closed adapter. The generic `external_signal` kind covers all of these in Plan 1; provider-specific adapters land in Plan 2.
- **Plan/routine templates.** Templates that carry a `default_required_outcomes` payload land in Plan 2 alongside Deep Planning's plan templates. Plan 1 only has `routines.default_required_outcomes`.
- **Automatic reopening on reversion.** Sticky terminals are the Plan 1 default — operators manually transition the parent back to `in_progress` if the work needs to redo. "Reverted → reopen" automation is opt-in in Plan 2.
- **Outcome aliases / OR-of-outcomes.** A contract slot is satisfied by exactly one outcome row. "Either approval-A *or* approval-B counts" requires a separate aliasing primitive that lands in Plan 2.
- **Cross-company outcome federation.** Each company's outcomes are isolated. No shared outcome kinds across the instance.
- **Work-items as a gated entity.** Work-items remain "succeeded when the run completes." Their *consequences* (artifacts, decisions, approvals) flow into the parent issue's contract; the work-item itself doesn't carry an outcome contract.
- **Plan-phase as a gated entity.** Phases get outcome support indirectly via the `exit_criteria_met` kind (a phase's `exit_criteria_markdown` becomes a verifiable outcome) but phases themselves aren't gateable. The phase's own status flow is unchanged.
- **MCP-Resource adapter.** External tools listing outcomes for an entity via MCP lands in Plan 2 alongside Memory's MCP server.
- **Auto-archival of verified rows.** Plan 1 keeps every outcome row forever for audit. Auto-archival policy lands in Plan 2.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  source-of-truth substrates (already shipped)        │
│                                                      │
│  ArtifactsService    ─┐                              │
│  PlansService        ─┤  emit on-commit              │
│  ApprovalsService    ─┤  via in-process events.ts    │
│  PlanService.phases  ─┘                              │
└──────────────┬───────────────────────────────────────┘
               │
               │ artifactsEvents.on("declared", …)
               │ plansEvents.on("completed", …)
               │ plansEvents.on("decisionRecorded", …)
               │ plansEvents.on("phaseCompleted", …)
               │ approvalsEvents.on("approved", …)
               ▼
┌──────────────────────────────────────────────────────┐
│  OutcomesService  (singleton, init at boot)         │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────────┐    │
│  │  contract.ts    │    │  predicate.ts        │    │
│  │  - parse        │    │  - allOutcomes-      │    │
│  │  - materialize  │    │      Verified()      │    │
│  │  - diff         │    │  - returns 422       │    │
│  └────────┬────────┘    └──────────┬───────────┘    │
│           │                        │                │
│           ▼                        ▼                │
│  ┌─────────────────────────────────────────────┐    │
│  │  outcomes table (pending/verified/reverted) │    │
│  └─────────────────────────────────────────────┘    │
│           ▲                        ▲                │
│           │                        │                │
│  ┌────────┴────────────────────────┴─────────┐      │
│  │  verifiers/                                │      │
│  │   artifact-declared    decision-recorded   │      │
│  │   plan-completed       approval-granted    │      │
│  │   exit-criteria-met    manual-signoff      │      │
│  │   external-signal  (HMAC + Idem-Key)       │      │
│  └────────────────────────────────────────────┘      │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│  gate-check call sites                               │
│                                                      │
│  issueService.updateIssue → done                    │
│   → if entity.required_outcomes.length              │
│       && !allOutcomesVerified() → throw 422         │
│                                                      │
│  PlanService.completePlan                            │
│   → same predicate                                   │
└──────────────────────────────────────────────────────┘
```

**Key boundary:** the four existing services *publish events* and **never call `OutcomesService` directly**. Each gains a 5-line `events.ts` exporting an in-process `EventEmitter` instance. `OutcomesService` is wired as a subscriber at boot. This keeps substrates decoupled — disabling Outcomes (env flag) leaves no orphan calls.

The same publish-subscribe boundary lets Memory and Org-Learning each become *additional* subscribers without coupling: Memory records outcome verifications as procedural memory entries; Org-Learning aggregates outcome shapes into mined playbooks.

## Schema

```sql
-- packages/db/src/migrations/00XX_enforced_outcomes.sql

CREATE TYPE outcome_target_kind AS ENUM ('issue', 'plan');

CREATE TYPE outcome_kind AS ENUM (
  'artifact_declared',
  'plan_completed',
  'decision_recorded',
  'approval_granted',
  'exit_criteria_met',
  'manual_signoff',
  'external_signal'
);

CREATE TYPE outcome_status AS ENUM ('pending', 'verified', 'reverted');

CREATE TABLE outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_kind     outcome_target_kind NOT NULL,
  target_id       uuid NOT NULL,                -- partial-FK enforced in code
  kind            outcome_kind NOT NULL,
  status          outcome_status NOT NULL DEFAULT 'pending',

  required_meta   jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_meta   jsonb,
  verified_at     timestamptz,
  verified_by_kind text,        -- 'agent' | 'user' | 'system' | 'webhook'
  verified_by_id   uuid,        -- agent_id or user_id; null for system/webhook
  reverted_at     timestamptz,
  reverted_reason text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Lookups by target ("show me the checklist for this issue/plan").
CREATE INDEX outcomes_target_idx
  ON outcomes(company_id, target_kind, target_id);

-- Pending-only partial index, used by the gate-check predicate.
CREATE INDEX outcomes_pending_idx
  ON outcomes(company_id, target_kind, target_id)
  WHERE status = 'pending';

-- One slot per (target, kind, name). `name` comes from required_meta->>'name';
-- it's required at contract write time. Lets a contract require multiple
-- outcomes of the same kind (two artifacts, two approvals, etc.).
CREATE UNIQUE INDEX outcomes_contract_uniq
  ON outcomes(company_id, target_kind, target_id, kind, (required_meta->>'name'))
  WHERE status IN ('pending', 'verified');

-- For external_signal idempotency-key dedup.
CREATE UNIQUE INDEX outcomes_signal_idem_uniq
  ON outcomes(company_id, id, (verified_meta->>'idempotency_key'))
  WHERE kind = 'external_signal' AND verified_meta->>'idempotency_key' IS NOT NULL;

-- Inline contracts on the gateable entities.
ALTER TABLE issues   ADD COLUMN required_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plans    ADD COLUMN required_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE routines ADD COLUMN default_required_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Per-company HMAC secret for external_signal verification.
ALTER TABLE companies ADD COLUMN outcome_signal_secret text;
```

**Per-kind `required_meta` JSON schemas** live in `packages/shared/src/outcome-kinds/*.ts`, mirroring the `artifact-kinds/` pattern shipped in Artifacts Plan 1. Each kind exports `{ requiredMetaSchema, verifiedMetaSchema, validate(meta) }`. Required-meta examples:

| kind | required_meta example | verified_meta on success |
|---|---|---|
| `artifact_declared` | `{name: "patch", artifact_kind: "code.patch", name_glob: "*.diff"}` | `{artifact_id, blob_sha256, declared_at}` |
| `plan_completed` | `{name: "rollout", plan_id?: uuid}` (uuid optional — if absent, matches first plan tagged with this issue) | `{plan_id, completed_at, revision_id}` |
| `decision_recorded` | `{name: "go-no-go", plan_id: uuid, decision_title: "release go-no-go"}` | `{decision_id, chosen_option_id, decided_at}` |
| `approval_granted` | `{name: "legal-signoff", approval_kind: "legal"}` | `{approval_id, decided_by_user_id, decided_at}` |
| `exit_criteria_met` | `{name: "phase-1-checks", plan_phase_id: uuid}` | `{checked_count, total_count, parsed_at}` |
| `manual_signoff` | `{name: "operator-ack", required_role?: "ops"}` | `{user_id, signed_at, note?}` |
| `external_signal` | `{name: "ci-pass", source: "github-actions"}` | `{idempotency_key, signature_verified, payload_sha256, received_at}` |

`required_meta.name` is mandatory and unique per (target, kind) — enforced by `outcomes_contract_uniq`. That's how a contract requires "two `artifact_declared` outcomes" with names `"patch"` and `"changelog"`.

The contract on the entity is just an array of those `required_meta` objects with the `kind` discriminator:

```json
"required_outcomes": [
  {"kind": "artifact_declared", "required_meta": {"name": "patch", "artifact_kind": "code.patch"}},
  {"kind": "approval_granted",  "required_meta": {"name": "legal-signoff", "approval_kind": "legal"}}
]
```

## Lifecycle

**Outcome row state machine.** Three transitions, each a guarded SQL update:

```
                  contract written
                         │
                         ▼
                     ┌───────┐
   tryVerify()       │pending│        markReverted()
   matches  ───────► └───┬───┘        (PR reverted, approval rescinded,
                         │             webhook reverter, operator UI)
                         │
                         ▼
                    ┌────────┐         ┌─────────┐
                    │verified├────────►│reverted │  (terminal, audit-only)
                    └────────┘         └─────────┘
                         │
                  no transition back; new row with
                  fresh `name` supersedes if needed
```

- `pending → verified` — `OutcomesService.tryVerify(targetKind, targetId, kind, evidence)`. SQL: `UPDATE outcomes SET status='verified', ... WHERE id = $id AND status='pending' RETURNING *`. The `WHERE status='pending'` clause makes concurrent tryVerify calls race safely.
- `verified → reverted` — `OutcomesService.revertOutcome(outcomeId, reason)`. Same guard pattern.
- `pending → deleted` — only via contract diff, when an operator drops a kind from `required_outcomes` before it ever verified. Verified rows that get dropped from the contract are *kept* (audit) but no longer gate.

**Re-verification after revert** is not allowed. A reverted outcome is a historical record. If the work redoes, the operator either:
1. Edits the contract to add a new slot (e.g., name `"patch-v2"`) — a new pending row materializes, gates the next attempt to `done`. Or:
2. Manually transitions the parent back to `in_progress` to indicate re-work; existing reverted rows stay; pending rows get re-checked when their evidence shows up.

**Sticky terminals.** When an outcome flips `verified → reverted`, the parent issue/plan **stays in its terminal state**. The UI surfaces a banner ("3 of 4 outcomes still verified; 1 reverted on $date") and emits `paperclip_outcome_reverted_total{reason_class}`. No automatic state flip.

**Per-kind verifier behavior:**

| kind | trigger | match logic |
|---|---|---|
| `artifact_declared` | `artifactsEvents.declared` fired post-commit by `ArtifactsService.declareArtifact()` | `artifact.kind` matches `required_meta.artifact_kind`; `artifact.name` matches `required_meta.name_glob`; artifact's target is the same issue (or one tagged on the plan when target_kind=plan) |
| `plan_completed` | `plansEvents.completed` from the existing `onPlanCompleted` callback | If `required_meta.plan_id` set, exact match. Otherwise: any plan whose `issue_id` (the existing `plans.issue_id` FK to `issues`) matches the outcome's issue target |
| `decision_recorded` | `plansEvents.decisionRecorded` from `PlanService.recordDecision()` | Exact `plan_id` + `title` match (matches against the existing `plan_decisions.title` column — no schema change to `plan_decisions`); verified iff `chosen_option_id IS NOT NULL` |
| `approval_granted` | `approvalsEvents.approved` from `ApprovalsService` status transition | `approval_kind` matches; approval is linked to the outcome's issue target via the existing `issue_approvals` join table |
| `exit_criteria_met` | `plansEvents.phaseCompleted` from `PlanService.completePhase()` OR `plansEvents.phaseMarkdownUpdated` | Pure parser counts `- [x]` vs `- [ ]` in `exit_criteria_markdown`; verified iff `total > 0 AND checked == total` |
| `manual_signoff` | `POST /api/companies/:cid/outcomes/:id/signoff` | `required_role` (if set) checked against user's company role; `verified_by_kind='user'`, `verified_by_id=user_id` |
| `external_signal` | `POST /api/companies/:cid/outcomes/:id/signal` with `Idempotency-Key` header + HMAC body signature | HMAC verified against `companies.outcome_signal_secret`. Idempotent on the key |

**`tryVerify` is idempotent and best-effort.** It looks up all pending outcomes for `(target, kind)`, scores each against the evidence, and verifies any that match. Re-firing the same event after the row is already verified is a no-op (the SQL guard returns zero rows). Verifier exceptions are caught, logged to activity log + telemetry, and **never bubble up to the source service** — the artifact gRPC frame must not fail because outcome verification hit a bug.

**Gate-check predicate** (`predicate.ts`):

```ts
export async function allOutcomesVerified(
  db: Db, target: { kind: OutcomeTargetKind; id: string }
): Promise<true | OutcomeRequiredError> {
  const pending = await db.select({ count: count() })
    .from(outcomes)
    .where(and(
      eq(outcomes.targetKind, target.kind),
      eq(outcomes.targetId, target.id),
      eq(outcomes.status, "pending"),
    ));
  if (pending[0].count > 0) {
    const list = await db.select(...).from(outcomes).where(...).where(eq(outcomes.status, "pending"));
    return new OutcomeRequiredError({ pending: list, target });
  }
  return true;
}
```

Called from:
- `issueService.updateIssue` when `oldStatus !== "done" && newStatus === "done" && entity.required_outcomes.length > 0`
- `PlanService.completePlan` when `plan.required_outcomes.length > 0`

The 422 body shape is consistent for both:

```json
{
  "code": "outcome_required",
  "target": { "kind": "issue", "id": "..." },
  "pending": [
    { "id": "...", "kind": "artifact_declared", "required_meta": {"name": "patch", ...} },
    { "id": "...", "kind": "approval_granted", "required_meta": {"name": "legal-signoff", ...} }
  ]
}
```

UI renders one component for both — the pending checklist becomes the action surface ("Sign off here", "View pending artifact", etc.).

## Service layer

`server/src/services/outcomes/service.ts` exports `OutcomesService` as a singleton, initialized at boot via `initializeOutcomesService({ db })` in `server/src/index.ts` after `ArtifactsService`, `PlansService`, `ApprovalsService` are up (so the events.ts emitters exist). Public methods:

```ts
class OutcomesService {
  // Contract management
  async materializeContract(target, contract): Promise<{inserted, kept, dropped}>;
  async listForTarget(target): Promise<OutcomeRow[]>;

  // Verification (called by subscribers; also from manual_signoff route)
  async tryVerify(kind, evidence): Promise<{ verifiedCount: number }>;
  async revertOutcome(outcomeId, reason): Promise<OutcomeRow>;

  // Webhook entry (external_signal)
  async ingestSignal(outcomeId, headers, rawBody): Promise<{ verified: boolean }>;

  // Per-company HMAC secret rotation
  async rotateSignalSecret(companyId): Promise<{ secret: string }>;
}
```

Boot wiring (in `server/src/index.ts`, after the four substrates are initialized):

```ts
const outcomesService = initializeOutcomesService({ db });
artifactsEvents.on("declared", (a) => outcomesService.tryVerify("artifact_declared", a));
plansEvents.on("completed", (p) => outcomesService.tryVerify("plan_completed", p));
plansEvents.on("decisionRecorded", (d) => outcomesService.tryVerify("decision_recorded", d));
plansEvents.on("phaseCompleted", (ph) => outcomesService.tryVerify("exit_criteria_met", ph));
plansEvents.on("phaseMarkdownUpdated", (ph) => outcomesService.tryVerify("exit_criteria_met", ph));
approvalsEvents.on("approved", (a) => outcomesService.tryVerify("approval_granted", a));
```

The `events.ts` module on each substrate is a 5-line `EventEmitter` export with typed event names. Substrates emit *after* the DB transaction commits — never inside the transaction — so a verifier crash can't roll back the source write.

## API surface

```
GET   /api/companies/:cid/outcomes?target_kind=&target_id=    list (checklist view)
GET   /api/companies/:cid/outcomes/:id                         single row + audit history
POST  /api/companies/:cid/outcomes/:id/signoff                 manual_signoff verifier
POST  /api/companies/:cid/outcomes/:id/signal                  external_signal webhook (HMAC + Idempotency-Key)
POST  /api/companies/:cid/outcomes/:id/revert                  operator-driven reversion
POST  /api/companies/:cid/outcomes/_secrets/signal/rotate      rotate per-company signal_secret (admin)
GET   /api/instance/outcomes                                   admin cross-company view
```

Contract writes ride the existing `PATCH /api/companies/:cid/issues/:id` and `PATCH /api/companies/:cid/plans/:id` with the new `required_outcomes` field — no new route. The handler calls `OutcomesService.materializeContract()` inside the same transaction as the entity update, so contract-state and entity-state are atomically consistent.

The webhook route mounts the existing Stripe-style `Idempotency-Key` middleware shipped with Work-Queues. Rejecting an unsigned or malformed signal returns `401`; idempotency replay returns `200` with the original outcome row.

## UI surface

- **Issue detail page** — new "Outcomes" tab between "Plan" and "Activity." Renders the checklist with status pills (pending/verified/reverted), evidence deep-links (artifact thumbnail / plan-detail link / approval-detail link), an "Edit contract" button (kind-picker dialog), a "Sign off" button per `manual_signoff` row, and a "Withdraw" button on verified rows for reversion.
- **Plan detail page** — same Outcomes tab using the same component. Plan-level vs issue-level contracts are visually distinguished by a target-kind chip on the row.
- **Status transition button** — when an operator clicks "Mark done" on an issue with pending outcomes, the existing button is disabled with a tooltip "3 outcomes still pending." Graceful prevention rather than waiting for the 422.
- **`/instance/outcomes`** — cross-company admin page. Same layout pattern as `/instance/work-queue` and `/instance/learning`: filterable table of all gated entities, status counts, drill-in to the per-entity checklist.
- **Routine config** — existing `/admin/routines/:id` page gains an "Outcomes contract" section with the same kind-picker. Setting it populates `routines.default_required_outcomes`; new issues created from the routine inherit the contract at insertion time.

## Observability

OTel spans (mirroring Memory / Plans / Org-Learning conventions, all under the `paperclip.outcome.*` prefix):

- `paperclip.outcome.materialize_contract` — span around contract diff write; attributes `target.kind`, `target.id`, `inserted_count`, `dropped_count`
- `paperclip.outcome.try_verify` — one span per verifier invocation; attributes `outcome.kind`, `outcome.target_kind`, `matched_count`
- `paperclip.outcome.gate_check` — span around `allOutcomesVerified`; attributes `target.kind`, `pending_count`
- `paperclip.outcome.revert` — span around revert path; attributes `outcome.kind`, `reason_class`
- `paperclip.outcome.signal_ingested` — span around webhook receipt; attributes `outcome.id`, `signature_valid`, `idempotency_replay`

Five metric streams:

- `paperclip_outcome_pending_total{kind,target_kind}` — gauge (observable, sampled by the metrics tick)
- `paperclip_outcome_verified_total{kind}` — counter
- `paperclip_outcome_reverted_total{kind,reason_class}` — counter
- `paperclip_outcome_gate_blocked_total{target_kind}` — counter (422s thrown)
- `paperclip_outcome_signal_received_total{outcome_id_low_card,verified}` — counter (cardinality-bound)

A sixth implicit stream is `paperclip_outcome_verifier_error_total{kind}` for the catch-and-log path; not in the public dashboard but emitted for ops triage.

## Error handling

- **Verifier exception** — caught inside `tryVerify`, logged to activity log, telemetry-counted, **never** bubbles to the source service.
- **Webhook signature mismatch** — `401 Unauthorized`. Body is generic; specifics in server logs.
- **Idempotency-Key replay** with verified outcome — `200 OK`, body is the existing outcome row. Replay with mismatched payload (same key, different body) — `409 Conflict`.
- **Contract validation error** at write time — `400 Bad Request` with the per-kind JSON-schema error body.
- **Reversion of an already-reverted outcome** — `409 Conflict` (we don't silently overwrite `reverted_reason`).
- **Reversion of a pending outcome** — `400 Bad Request` (revert flow is only for verified rows; drop-from-contract path handles pending removals).
- **Manual sign-off without required role** — `403 Forbidden`.
- **Manual sign-off on a non-`manual_signoff` outcome** — `400 Bad Request` (kind mismatch).

## Testing strategy

TDD discipline, one task per failing test (matching the pattern used in Memory / Artifacts / Work-Queues / Plans / Org-Learning Plan 1):

- **Pure unit tests** — per-kind `required_meta` validators (`packages/shared/src/outcome-kinds/*.test.ts`); contract-diff helper; markdown-checkbox parser; HMAC verifier
- **Service tests** — `OutcomesService.materializeContract` insert/leave/drop diff cases; `tryVerify` happy path + idempotent re-fire; `revertOutcome` guard against double-revert; `ingestSignal` HMAC + idempotency
- **Predicate tests** — `allOutcomesVerified` with mixed status sets; partial-index sanity (pure SQL test asserting the pending index plan is used via `EXPLAIN`)
- **Subscriber wiring tests** — boot path: artifact event fires → matching pending outcome flips to verified
- **Integration tests** — full path: issue contract → artifact declared → outcome verified → status flip allowed; same for plan; external_signal webhook path
- **E2E smoke** — extend `scripts/smoke/tier1-e2e.sh` with an outcomes block: create issue with contract → attempt `status=done` (expect 422) → declare artifact → retry `status=done` (expect 200)

## Plan 1 implementation phases

1. **Migration** — `outcomes` table, indexes, `issues.required_outcomes`, `plans.required_outcomes`, `routines.default_required_outcomes`, `companies.outcome_signal_secret`.
2. **Per-kind schemas** — `packages/shared/src/outcome-kinds/*.ts` with `requiredMetaSchema`, `verifiedMetaSchema`, `validate()`.
3. **Pure helpers** — contract-diff, checkbox parser, HMAC verifier.
4. **`OutcomesService` skeleton** — singleton, init wiring, `materializeContract`, `listForTarget`.
5. **Per-kind verifiers** — one task each: `artifact_declared`, `plan_completed`, `decision_recorded`, `approval_granted`, `exit_criteria_met`, `manual_signoff`, `external_signal`. (Seven phases — could be batched if straightforward.)
6. **`events.ts` emitters on substrates** — Artifacts, Plans, Approvals each gain a 5-line emitter; existing services emit post-commit.
7. **Boot wiring** — subscribers in `server/src/index.ts`.
8. **Predicate + gate-check integration** — `predicate.ts`; integration into `issueService.updateIssue` and `PlanService.completePlan`.
9. **REST routes** — list, get, signoff, signal, revert, instance admin, secret rotate.
10. **UI: Outcomes tab on issue + plan detail.**
11. **UI: `/instance/outcomes` admin page.**
12. **UI: routine config "Outcomes contract" section + inheritance on issue creation.**
13. **Memory subscriber recording outcome.verified/reverted as procedural entries.**
14. **OTel spans + 5 metric streams.**
15. **E2E smoke addition.**

## Risks

- **Verifier accuracy.** A bug in a verifier flips outcomes to verified incorrectly, ungating a 422 that should have stuck. Mitigation: per-kind verifier tests for the false-positive paths; `paperclip_outcome_verified_total{kind}` dashboard for anomalous spikes; reversion is always available as a recovery.
- **Contract drift.** An operator edits `required_outcomes` after the issue is in flight. The diff should be safe (insert new pending, leave verified, drop pending) but races with concurrent verification. Mitigation: materialize-contract runs in the same transaction as the entity PATCH; `tryVerify` uses the `WHERE status='pending'` SQL guard.
- **Webhook abuse.** A leaked HMAC secret lets an attacker mark outcomes verified. Mitigation: per-company secret (not per-instance), rotatable from admin UI, and `signature_verified` recorded in `verified_meta` for every external_signal — easy to grep for unsigned verifications.
- **Adoption friction.** Operators forget to set contracts; outcomes stays "the new thing nobody uses." Mitigation: `routines.default_required_outcomes` makes recurring work easy; the issue/plan create dialogs default to "no outcomes required" (zero-friction opt-in); telemetry counts how many issues have contracts so we can measure adoption.
- **Reversion noise.** A flaky external_signal source causes outcomes to bounce verified→reverted→verified. Mitigation: re-verification after revert is disallowed (Plan 1); operator must add a new slot. This is intentional friction — outcome bouncing is a flag for the operator to investigate the source, not for us to silently absorb.
- **Substrate event lag.** `events.ts` is in-process and synchronous; if `OutcomesService.tryVerify` is slow, it backs up the source service's response. Mitigation: `tryVerify` is async-fire-and-forget from the source service's perspective (subscriber path doesn't `await`); errors logged.

## Decisions

- **Outcomes as a uniform substrate, not embedded in each substrate.** A single `outcomes` table with polymorphic target avoids four schema patches and keeps the gate check as one query. Mirrors how Artifacts ships per-kind metadata via JSON-schema validation.
- **Hard gate when required, no-op otherwise.** Universal hard gate breaks ad-hoc / decorative issues; soft warning doesn't actually enforce anything. Opt-in contract via `required_outcomes.length > 0` is the right granularity.
- **Inline contracts on the entity, not a separate `outcome_contracts` table.** Matches existing patterns (`plan.approval_policy`, `work_item.retry_policy`). One row, one read for the gate check.
- **Eager materialization of pending rows on contract write.** Operators see the full checklist immediately — pending vs verified is what makes the UI useful. Lazy creation would mean "this issue requires X" never shows X until verification happens.
- **Subscribe-don't-call boundary.** OutcomesService never imports from artifacts/plans/approvals. Each substrate stays sovereign over its data; the events.ts emitter is the only seam.
- **Sticky terminals + audit reversion (Plan 1).** Auto-reopening on revert is a UX choice that varies by team — we ship the conservative default and Plan 2 layers in opt-in auto-reopen.
- **Approvals stay sovereign.** The existing approvals UI/service is unchanged; `approval_granted` only observes. Avoids a UX migration for an already-shipped feature.
- **Work-items stay outside the gate.** Their consequences (artifacts, decisions, approvals) flow into the parent issue's contract; gating the work-item itself conflicts with the retry/dead-letter machine and isn't needed.
- **Manual sign-off as a first-class kind in Plan 1.** Without it, "I declare this done by judgment" has no clean home — operators end up using `external_signal` with a fake webhook, which is worse for audit.

## Notes on deferred concerns

- **Provider-specific webhook adapters.** GitHub PR-merge, GitHub-Actions CI-pass, Linear issue-closed — Plan 2 once `external_signal` is exercised.
- **Plan + routine templates** with `default_required_outcomes`. Plan 2 alongside Deep Planning's plan templates.
- **`playbooks.suggested_outcomes`** — Org Learning extension that auto-populates contracts when a playbook is applied. Plan 2.
- **Auto-reopen on reversion.** Per-kind opt-in (`auto_reopen_on_revert: true` in `required_meta`). Plan 2.
- **Outcome aliases / OR-of-outcomes.** A contract slot satisfied by multiple alternative outcomes. Plan 2.
- **Auto-archival** of old verified rows. Plan 2 — Plan 1 keeps everything for audit.
- **MCP-Resource adapter** for outcomes. Plan 2 alongside Memory's MCP server.
- **Cross-company outcome federation.** Out of scope for Plan 2 too — companies stay isolated.

## Open questions

1. **Should `manual_signoff` require multi-party signoff?** Today's design is single-user. Some teams will want "two ops must sign" — could be modeled by requiring two separate `manual_signoff` outcomes with distinct names, or by adding a `min_signers` field. v1 single-user; revisit if requested.
2. **External-signal kind retention after revert.** Today an external_signal that's reverted requires a new contract slot to re-verify. Some sources (e.g., a flaky CI) might naturally flap. Should there be a per-kind opt-in for "retry on revert"? Probably yes in Plan 2 alongside the auto-reopen flag.
3. **Contract editing window.** Should operators be able to edit `required_outcomes` after the parent is `done`? Current design says no — once done, the contract is frozen (otherwise removing a verified outcome could "undo" doneness conceptually). Confirm with first users.
4. **Default `name` field.** Operators have to provide `name` per slot; making it optional with `kind` as default works for single-kind contracts but breaks the multi-kind case. Worth a UX lint at write time ("name conflict — please disambiguate").
5. **Cross-target outcomes.** A plan-level outcome that's satisfied by an issue-level event (e.g., "any of my child issues has artifact_declared"). Current design is target-scoped; cross-target is a Plan 2 question — but if first users ask for it we may need to surface it earlier.

---

*Draft: 2026-05-10. Review with: spec author + ops lead (for the reversion/gate UX) + worker-runtime owner (for the events.ts emitter pattern across substrates). Plan document follows.*
