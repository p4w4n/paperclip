# Enforced Outcomes — Plan 2 Design

> Sequel spec for the **Enforced Outcomes** roadmap milestone. Plan 1 (`2026-05-10-enforced-outcomes-design.md`) shipped the substrate: `outcomes` table, 7 typed kinds, gate-check predicate, REST + UI surfaces, Memory subscriber, OTel spans, e2e smoke. Plan 2 layers in **plan + routine templates carrying default contracts, a GitHub PR-merged webhook adapter, `playbooks.suggested_outcomes` autopopulation, per-kind opt-in reopen-on-revert, and outcome aliases (OR-of-outcomes for a single slot)**. Plan 3 (deferred) covers auto-archival, MCP-Resource adapter, additional vendor webhook adapters, cross-target outcomes, and nested alias groups.

## Problem

Plan 1 made governance possible — operators can declare a `required_outcomes` contract on an issue or plan, the gate-check rejects terminal-state transitions until each slot is verified, and the artifact / plan / approval / phase / signoff / signal verifier kinds cover the core completion-evidence shapes. Lake Analytics has been migrated to it and uses it on real issues.

But the day-to-day experience surfaces five gaps that aren't substrate problems — they're integration and ergonomics shortfalls:

1. **Contracts are per-entity boilerplate.** Operators set the same contract shape over and over on similar issues — backtest issues all need a doc + risk-approval + ops-signoff; bug-fix issues all need a code.patch + CI pass. There's no template surface that says "this kind of work always wants this contract." Routine inheritance (Plan 1) covers recurring jobs but not plan creation.

2. **GitHub PR merges are the most common "external completion signal" — and there's no native bridge.** Plan 1 ships `external_signal` as a generic HMAC webhook, but every team has to write its own GitHub → paperclip translator. That's friction for the most common verification path.

3. **Org Learning already mines `playbooks` that imply what good contracts look like, but the suggestion path stops at the prompt-prefix.** A playbook says "when X type of issue, take steps A, B, C" — implicitly, "and produce outputs D, E." There's no way to project that playbook's implied outcomes into the issue's contract.

4. **Reverts always stay sticky.** Sometimes that's right (a code-merged audit shouldn't reopen the issue just because the PR was reverted weeks later). Sometimes it's wrong (a CI-pass outcome reverting because tests broke later SHOULD reopen the issue). There's no per-contract policy for the choice.

5. **Contracts are AND-only.** Slot must be satisfied by THIS kind with THIS name. No way to express "either CI passes OR ops manually signs off." Real governance has alternatives.

The 2026 industry pattern for these gaps is layered: contract templates (Linear / GitHub Projects), provider-specific webhook adapters (Stripe-style integrations), declarative AND/OR satisfaction (GitHub Required Status Checks). Plan 2 brings these to Paperclip on top of the Plan 1 substrate without adding new verifier primitives.

## Goals

1. **Plan templates** — a new `plan_templates` table per company carrying `default_required_outcomes` (and an optional `default_phases` skeleton). `POST /api/companies/:cid/plans { templateId, ... }` materializes the template's contract onto the new plan at creation time.

2. **GitHub PR-merged webhook adapter** — `POST /api/companies/:cid/webhooks/github` translates a `pull_request.closed (merged=true)` event into an `external_signal` outcome verification. HMAC-verified against a per-company `github_webhook_secret` (separate column from `outcome_signal_secret`). Audited in a new `github_webhook_deliveries` table for replay protection + debugging.

3. **`playbooks.suggested_outcomes`** — extend the `playbooks` row with an optional `suggested_outcomes` JSONB column. Operator-driven `POST /issues/:id/apply-playbook` merges those into the issue's `required_outcomes`. The existing `suggestPlaybooks` prompt-prefix flow stays unchanged.

4. **Per-kind opt-in reopen-on-revert** — `required_meta.auto_reopen_on_revert: true` on a contract entry. When the outcome flips `verified → reverted`, the parent issue/plan auto-flips back to `in_progress` (only if the slot is no longer satisfied after the revert; alternatives covering the slot suppress the reopen). Sticky-by-default preserved.

5. **Outcome aliases (single-level OR)** — a contract entry gains an optional `alternatives: ContractEntry[]` field. Slot is satisfied if the primary OR any alternative reaches `verified`. Materialized in the existing `outcomes` table using `:alt:N` name suffix; no new join table. Single-level only — nested AND/OR groups land in Plan 3 if needed.

## Non-goals (v2)

- **Auto-archival of old verified rows.** Plan 3 — will move to `outcomes_archive` table or partition by month.
- **MCP-Resource adapter** for outcomes. Couples to Memory Plan 2's MCP server. Plan 3.
- **Linear / GitHub-Actions / generic-CI webhook adapters.** Pattern is established by Plan 2's GitHub adapter; straight extension in Plan 3.
- **Cross-target outcomes.** "A plan-level outcome is satisfied when any child issue verifies its own outcome." Plan 3.
- **Nested alias groups.** No `any_of` / `all_of` group composition. Plan 2 ships flat alternatives only.
- **Live template binding.** Plan-2 templates are single-shot copy. Edits don't propagate to plans already created. Live binding adds policy questions (does template edit affect in-flight plans?) without clear win. Plan 3 if needed.
- **Template versioning.** No template revision chain. Plan 3 if requested.
- **Auto-applied playbook contracts.** Playbook contract application stays operator-driven. Auto-apply lands in MAXIMIZER mode.
- **GitHub App installation flow.** Webhook auth uses a per-company HMAC secret only. Full GitHub App with installation tokens is Plan 3 enterprise milestone.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  EO Plan 1 substrate (already shipped)                                 │
│                                                                        │
│  outcomes table (polymorphic target, 7 typed kinds, status FSM)        │
│  issues.required_outcomes  /  plans.required_outcomes                  │
│  routines.default_required_outcomes  (inheritance at issue create)     │
│  companies.outcome_signal_secret  (HMAC for generic external_signal)   │
│  OutcomesService.{materializeContract, tryVerify, revertOutcome,       │
│                   signOff, ingestSignal}                               │
│  artifactsEvents/plansEvents/approvalsEvents → outcomesEvents          │
│  gate-check predicate at issue.status='done' + PlanService.completePlan│
└──────────────────────┬─────────────────────────────────────────────────┘
                       │
                       │  PLAN 2 LAYERS ON TOP:
                       │
                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Plan 2 surfaces                                                       │
│                                                                        │
│  plan_templates table              ─┐                                  │
│  PlanTemplateService                │                                  │
│  PlanService.createPlan { templateId } ───► materializeContract       │
│                                                                        │
│  routes/webhooks/github            ─┐                                  │
│  github_webhook_deliveries (audit)  │                                  │
│  companies.github_webhook_secret    │── thin adapter, delegates to     │
│  HMAC verify + dedup by delivery_id │   existing ingestExternalSignal  │
│                                                                        │
│  playbooks.suggested_outcomes      ─┐                                  │
│  OutcomesService.applyPlaybookToIssue                                  │
│  (operator-driven; merge with skip_existing | replace)                 │
│                                                                        │
│  required_meta.auto_reopen_on_revert: bool                             │
│  OutcomesService.revertOutcome → emits 'reverted' event                │
│    → if flag && slot no longer satisfied: parent → in_progress         │
│                                                                        │
│  ContractEntry.alternatives: ContractEntry[]                           │
│  materialized as :alt:N suffix sibling rows                            │
│  allOutcomesVerified groups by base-name slot                          │
└────────────────────────────────────────────────────────────────────────┘
```

**Key boundary preserved.** Plan 2 introduces **zero new verifier primitives.** The GitHub webhook delegates to `ingestExternalSignal`. The aliases use existing `outcomes` rows with a naming convention. The reopen-on-revert path is implemented inside `revertOutcome` as a post-success best-effort step. The Plan 1 publish-subscribe boundary stays intact.

## Schema

Migration `0094_enforced_outcomes_plan_2.sql`. Two new tables, two column additions, three indexes (two partial-where, hand-edited).

```sql
-- 1. Plan templates — reusable contracts for plans.
CREATE TABLE plan_templates (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                       text NOT NULL,
  description                text,
  default_required_outcomes  jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_phases             jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived_at                timestamptz,
  created_by_user_id         text,
  created_by_agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Hand-edited partial indexes (drizzle-kit doesn't emit WHERE clauses).
CREATE INDEX plan_templates_company_idx
  ON plan_templates(company_id) WHERE archived_at IS NULL;

CREATE UNIQUE INDEX plan_templates_company_name_uniq
  ON plan_templates(company_id, name) WHERE archived_at IS NULL;

-- 2. Per-company GitHub webhook secret. Separate from outcome_signal_secret
--    for security isolation (a leak of one doesn't compromise the other).
ALTER TABLE companies ADD COLUMN github_webhook_secret text;

-- 3. GitHub webhook delivery audit. Bounded growth via X-GitHub-Delivery
--    unique index + dedup on replay.
CREATE TABLE github_webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  delivery_id     text NOT NULL,
  event_type      text NOT NULL,
  action          text,
  pr_url          text,
  outcome_id      uuid REFERENCES outcomes(id) ON DELETE SET NULL,
  signature_valid boolean NOT NULL,
  result          text NOT NULL,        -- 'verified' | 'no_match' | 'invalid_signature' | 'ignored'
  raw_body_sha256 text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX github_webhook_deliveries_uniq
  ON github_webhook_deliveries(company_id, delivery_id);

CREATE INDEX github_webhook_deliveries_company_idx
  ON github_webhook_deliveries(company_id, received_at DESC);

-- 4. playbooks gains a suggested_outcomes column.
ALTER TABLE playbooks ADD COLUMN suggested_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb;
```

**Contract-entry schema extensions** in `packages/shared/src/outcome-kinds/contract-entry.ts` (NEW):

```ts
import { z } from "zod";

const contractAlternativeSchema = z.object({
  kind: z.enum(OUTCOME_KINDS),
  requiredMeta: z.record(z.unknown()),
});

export const contractEntrySchema = z.object({
  kind: z.enum(OUTCOME_KINDS),
  requiredMeta: z.record(z.unknown()),
  // Single-level OR: this slot is satisfied if THIS entry verifies OR any alternative verifies.
  alternatives: z.array(contractAlternativeSchema).optional(),
});

// Per-kind requiredMetaSchema gains optional auto_reopen_on_revert.
// Applied to each of the 7 kinds in packages/shared/src/outcome-kinds/*.ts.
// e.g.:
export const externalSignalSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  auto_reopen_on_revert: z.boolean().optional(),
});
```

**Alias slot row layout in `outcomes`**. Materializing a contract entry with one alternative produces TWO rows sharing a base name:

```
outcomes(target_kind=issue, target_id=I, kind=external_signal,
         required_meta={name: "ci-pass", ...}, status=pending)
outcomes(target_kind=issue, target_id=I, kind=manual_signoff,
         required_meta={name: "ci-pass:alt:0", ...}, status=pending)
```

The base name is `"ci-pass"`. Sibling alternative names are `"ci-pass:alt:N"` (N = position in `alternatives[]`). The existing `outcomes_contract_uniq` partial index continues to enforce slot uniqueness — each sibling has a distinct name, so no collision.

## Lifecycle

### A. Plan-template inheritance (single-shot copy)

```
PlanTemplate(name="Strategy Rollout", default_required_outcomes=[...])
        │
        │  POST /api/companies/:cid/plans { templateId, ... }
        ▼
PlanService.createPlan()
  ├─ insert plan row (status="draft")
  ├─ if templateId set:
  │     template := lookup by id; throw PlanTemplateNotFoundError if missing/archived
  │     plan.required_outcomes := deep-clone of template.default_required_outcomes
  │     OutcomesService.materializeContract({kind:"plan", id, companyId}, contract)
  └─ commit
```

The template is a starting point, not a live link. Once a plan is created, it owns its contract; further template edits don't propagate. Same pattern routines used in Plan 1.

### B. GitHub PR-merged webhook → `external_signal` verification

```
POST /api/companies/:cid/webhooks/github
  headers:
    X-GitHub-Event: pull_request
    X-Hub-Signature-256: sha256=<hex>
    X-GitHub-Delivery: <uuid>
  body: {"action":"closed","pull_request":{"merged":true, ...}}

Route handler:
  1. Verify HMAC against companies.github_webhook_secret.
     Invalid → 401, audit row(signature_valid=false, result='invalid_signature').
  2. Dedup: github_webhook_deliveries.(company_id, delivery_id) seen before?
     Replay → 200 with the prior outcome_id, no further work.
  3. Filter: event_type != 'pull_request' OR action != 'closed' OR !payload.pull_request.merged
     → 200, audit row(result='ignored').
  4. Resolve issue: extract identifier from PR title/body/branch (try in order).
     No match → 200, audit row(result='no_match').
  5. Find pending external_signal outcomes for that issue with required_meta.source='github'.
  6. For each match: call ingestExternalSignal({outcomeId, companyId, rawBody, signature,
                                                 idempotencyKey: deliveryId}).
  7. Audit row(result='verified', outcome_id=...). Return 200 with matched_outcomes.
```

GitHub is a **thin adapter** over the existing `ingestExternalSignal` verifier. One new route + one audit table; no new verifier primitive.

### C. `playbooks.suggested_outcomes` → contract application

```
playbook.suggested_outcomes = [
  {kind: artifact_declared, requiredMeta: {name: "backtest-report", artifact_kind: "doc.markdown"}},
  {kind: approval_granted,  requiredMeta: {name: "risk-signoff", approval_kind: "risk"}},
]
                │
                │  Operator: [Apply] button on IssueDetail
                ▼
POST /api/companies/:cid/issues/:id/apply-playbook { playbookId, mergeStrategy }
  ├─ load playbook; throw PlaybookNotApplicableError if matchPlaybookApplicability score = 0
  ├─ merge: skip_existing | replace
  │     skip_existing: existing contract entries (by kind+name) take precedence; new ones added
  │     replace:       drop existing pending rows, replace contract with playbook's
  ├─ OutcomesService.materializeContract(target, mergedContract)
  ├─ UPDATE issues SET required_outcomes = mergedContract
  └─ activityLog: "Applied playbook X — added N outcomes (skipped M existing)"
```

`mergeStrategy` defaults to `skip_existing` (the safer choice; preserves operator-set contract entries).

### D. Per-kind opt-in reopen-on-revert

```
outcome row in DB:
  status='verified', required_meta.auto_reopen_on_revert = true

POST /api/companies/:cid/outcomes/:id/revert {reason}
  │
  ▼
OutcomesService.revertOutcome(outcomeId, reason)
  ├─ guarded UPDATE: status='reverted', reverted_at, reverted_reason  (P1 logic)
  ├─ emit outcomesEvents.emit('reverted', {outcomeId, target, kind, reason})
  └─ if reverted_row.required_meta.auto_reopen_on_revert === true:
       try {
         // Slot-recheck: does an alternative still cover the slot?
         siblings := outcomes(target=parent, base_name = strip_alt_suffix(reverted.name))
         if siblings.some(s => s.status === 'verified' && s.id !== reverted.id):
            // Slot still satisfied by alternative — do NOT reopen.
            paperclip_outcome_auto_reopen_suppressed_total{reason='alt_covers'} += 1
            return
         parent := load(reverted.target_kind, reverted.target_id)
         if parent.status in TERMINAL_STATES:
            UPDATE issues/plans SET status='in_progress', completed_at=NULL
            activityLog: "Auto-reopened after outcome revert (kind=X, reason=Y)"
            paperclip_outcome_auto_reopen_total{kind, target_kind} += 1
       } catch (err) {
         // Best-effort. Revert still succeeded.
         paperclip_outcome_auto_reopen_failed_total{kind, target_kind, reason_class} += 1
       }
```

Sticky-by-default preserved. Without the flag, Plan 1 behavior unchanged.

### E. Outcome aliases (OR-of-outcomes)

Contract entry with alternatives materializes one slot into N+1 outcome rows:

```
input:
  {kind: external_signal,
   requiredMeta: {name: "ci-pass", source: "github-actions"},
   alternatives: [{kind: manual_signoff, requiredMeta: {required_role: "ops"}}]}

materialized rows:
  outcomes(kind=external_signal, required_meta={name: "ci-pass", source: "github-actions"})
  outcomes(kind=manual_signoff,  required_meta={name: "ci-pass:alt:0", required_role: "ops"})
```

Per-kind verifiers don't change. The **gate predicate** changes:

```ts
function isSlotSatisfied(rows: OutcomeRowLite[], slotBaseName: string): boolean {
  return rows.some(r =>
    r.status === 'verified' &&
    (r.requiredMeta.name === slotBaseName ||
     r.requiredMeta.name.startsWith(`${slotBaseName}:alt:`))
  );
}

// allOutcomesVerified groups all outcome rows by base-name slot, then
// checks each slot is satisfied. A slot is blocking iff NO row in the
// group is verified.
```

Pending sibling rows whose slot is already satisfied stay alive (so re-verification still races safely via the SQL guard). The gate ignores them.

## Service layer

```ts
// server/src/services/templates/service.ts
class PlanTemplateService {
  async create(ctx, input):    Promise<PlanTemplate>;
  async update(ctx, id, patch): Promise<PlanTemplate>;
  async archive(ctx, id):      Promise<void>;
  async restore(ctx, id):      Promise<PlanTemplate>;
  async listActive(ctx):       Promise<PlanTemplate[]>;
  async getById(ctx, id):      Promise<PlanTemplate | null>;
}

// server/src/services/plans/service.ts (extended)
class PlanService {
  async createPlan(ctx, { ...existing, templateId?: string }): Promise<Plan> {
    // ... existing path ...
    if (templateId) {
      const tmpl = await getPlanTemplateService().getById(ctx, templateId);
      if (!tmpl) throw new PlanTemplateNotFoundError(templateId);
      await this.deps.db.update(plans).set({
        requiredOutcomes: tmpl.defaultRequiredOutcomes
      }).where(eq(plans.id, plan.id));
      await getOutcomesService().materializeContract(
        { kind: "plan", id: plan.id, companyId: ctx.callerCompanyId },
        tmpl.defaultRequiredOutcomes
      );
    }
    return plan;
  }
}

// server/src/services/outcomes/service.ts (extended)
class OutcomesService {
  async revertOutcome(outcomeId, reason): Promise<OutcomeRowLite & { parentReopened: boolean }> {
    // ... existing guarded UPDATE ...
    outcomesEvents.emit('reverted', { ... });
    let parentReopened = false;
    if (reverted.requiredMeta.auto_reopen_on_revert === true) {
      try {
        if (!isSlotStillSatisfied(reverted)) {
          await reopenParent(reverted.targetKind, reverted.targetId);
          parentReopened = true;
        }
      } catch (err) { /* logged, counted, swallowed */ }
    }
    return { ...reverted, parentReopened };
  }

  async applyPlaybookToIssue(ctx, issueId, playbookId, mergeStrategy): Promise<ApplyPlaybookResult>;
}

// server/src/services/outcomes/webhooks/github.ts
export async function ingestGithubWebhook(db, input: {
  companyId: string;
  deliveryId: string;
  eventType: string;
  signature: string;
  rawBody: string;
}): Promise<{ verified: boolean; matchedOutcomes: string[]; result: string }>;
```

## API surface

```
NEW — Plan templates
  GET    /api/companies/:cid/plan-templates                  list active
  GET    /api/companies/:cid/plan-templates/:id              single
  POST   /api/companies/:cid/plan-templates                  create
  PATCH  /api/companies/:cid/plan-templates/:id              update
  POST   /api/companies/:cid/plan-templates/:id/archive
  POST   /api/companies/:cid/plan-templates/:id/restore

NEW — GitHub webhook
  POST   /api/companies/:cid/webhooks/github                 HMAC-only auth
  POST   /api/companies/:cid/webhooks/github/_secret/rotate  admin
  GET    /api/companies/:cid/webhooks/github/deliveries      last 50 (audit)

NEW — Playbook application
  POST   /api/companies/:cid/issues/:id/apply-playbook       { playbookId, mergeStrategy }

EXTENDED — Plan creation accepts templateId
  POST   /api/issues/:issueId/plans                          + optional { templateId }

EXTENDED — Outcomes revert returns parent_reopened
  POST   /api/companies/:cid/outcomes/:id/revert             same input; response gains
                                                             parent_reopened, slot_still_satisfied

EXTENDED — Outcomes list surfaces alias context
  GET    /api/companies/:cid/outcomes                        each row gains alternatives[],
                                                             slot_base_name, slot_satisfied
```

### Error classes (new)

| Error | Status | When |
|---|---|---|
| `PlanTemplateNotFoundError` | 404 | `POST /plans { templateId }` references missing/archived template |
| `GitHubWebhookSecretNotConfiguredError` | 404 | webhook hits a company whose secret hasn't been rotated |
| `WebhookSignatureMismatchError` | 401 | reuses `SignalAuthError` body shape |
| `PlaybookNotApplicableError` | 422 | `apply-playbook` invoked but applicability score is 0 |
| `OutcomeAliasResolutionError` | 500 | invariant violation — alias rows missing base slot |

Plan 1 error classes (`OutcomeRequiredError`, `SignoffRoleMismatchError`, `SignalAuthError`, `SignalReplayMismatchError`) keep their semantics.

## UI surface

```
NEW pages:
  /admin/plan-templates                              PlanTemplates list + edit + archive
  CompanySettings → Integrations tab                 GitHubWebhookCard
  Create-plan modal                                  PlanTemplatePicker dropdown

EXTENDED:
  IssueDetail → Memory/Playbooks panel               [Apply] button on suggested playbooks
                                                     opens modal with merge-strategy radio
  OutcomesTab                                        alias groups render as one collapsible row
                                                     with 🔀 any-of badge; auto-reopen rows
                                                     show 🔁 reopens-on-revert badge
  /instance/outcomes                                 same alias rendering as OutcomesTab
```

GitHub webhook setup card shows: connection status, webhook URL (operator copies to GitHub repo settings), masked secret with `[Rotate]` + `[Show docs]` buttons, last 5 deliveries with verdict (verified / ignored / invalid_signature). Rotate opens a modal showing the new secret once with a "I've configured this in GitHub" confirm.

Apply-playbook modal lists the playbook's `suggested_outcomes` with each marked **NEW** (will be added) or **SKIP** (already in contract by kind+name), plus a radio toggle for `skip_existing` (default) vs `replace`. Operator confirms; UI re-fetches Outcomes tab.

OutcomesTab alias groups:

```
Before (Plan 1, flat siblings):       After (Plan 2 alias group):

ci-pass     pending                   ci-pass        🔀 any-of    ✓ Satisfied
ci-pass:alt:0  pending                  ├─ external_signal        verified
                                        └─ manual_signoff         pending  [Sign off]

For verified rows that opted in:
ci-pass     verified  🔁 reopens-on-revert   [Withdraw]
```

## Observability

OTel spans (added under existing `paperclip-outcomes` meter):

```
paperclip.outcome.apply_template          { template_id, plan_id, contract_size }
paperclip.outcome.webhook_github          { delivery_id, event_type, action,
                                            signature_valid, result, matched_count }
paperclip.outcome.apply_playbook          { playbook_id, issue_id, added_count, skipped_count }
paperclip.outcome.auto_reopen             { outcome_id, target_kind, reason_class, reopened }
```

Metric streams (added — 5 new, plus 2 supporting):

```
paperclip_outcome_template_applied_total          { template_id_low_card }
paperclip_outcome_webhook_received_total          { source = "github", result }
paperclip_outcome_webhook_signature_failed_total  { source = "github" }
paperclip_outcome_playbook_applied_total          { playbook_id_low_card, added_count_bucket }
paperclip_outcome_auto_reopen_total               { kind, target_kind }
paperclip_outcome_auto_reopen_failed_total        { kind, target_kind, reason_class }
paperclip_outcome_alias_slot_satisfied_total      { primary_kind, satisfied_by = "primary" | "alternative" }
```

Cardinality protection: `template_id_low_card` / `playbook_id_low_card` are first-8-chars of the UUID (Plan 1 pattern).

## Failure modes and error handling

| Scenario | Behavior |
|---|---|
| Webhook arrives with invalid signature | 401, audit row(signature_valid=false), counter ticks |
| Webhook arrives with valid signature but for a closed-not-merged PR | 200, audit row(result='ignored'), no outcome touched |
| Webhook arrives with valid signature, merged PR, but no issue match | 200, audit row(result='no_match'), no outcome touched |
| Webhook replay (same delivery_id) | 200 with prior outcome_id, no new work |
| Template invoked at plan creation but doesn't exist | 404 `PlanTemplateNotFoundError` |
| Template invoked but archived | 404 `PlanTemplateNotFoundError` (treats archived as missing) |
| Apply-playbook with score=0 applicability | 422 `PlaybookNotApplicableError` |
| Apply-playbook with `skip_existing` and total overlap | 200 with `addedOutcomes: [], skippedExisting: [...]` |
| Reopen-on-revert tries to reopen but parent is already in_progress | no-op; reopen counter ticks; activityLog notes |
| Reopen-on-revert tries to reopen but slot is still satisfied by alternative | suppressed; `auto_reopen_suppressed_total{reason='alt_covers'}` counter ticks |
| Reopen-on-revert fails to update parent (e.g., DB error) | logged + `auto_reopen_failed_total` ticks; revert itself still succeeds |
| Alias slot resolution finds no base entry | 500 `OutcomeAliasResolutionError` — should never happen; loud log |

## Testing strategy

TDD discipline, one task per failing test. Same patterns as Plan 1.

Pure unit tests:
- `apply-template.ts` — projection + deep-clone semantics + missing-template error
- `apply-suggested-outcomes.ts` — merge logic (skip_existing vs replace), de-dupe by (kind, name)
- `alias-resolver.ts` — slot-satisfaction logic, base-name + `:alt:N` matching, multi-alternative groups
- `reopen-on-revert.ts` — `shouldReopenParent` with slot-recheck (no spurious reopen if alternative covers)
- `github-payload-parser.ts` — issue-id extraction from PR title/body/branch, merged-vs-closed detection
- Per-kind validator extensions for `auto_reopen_on_revert` + `alternatives` shape

Service-level tests (in-process fakeDb):
- `PlanTemplateService.create/update/archive/restore` happy paths + collision on name uniq
- `PlanService.createPlan { templateId }` materializes contract + emits span + counter
- `OutcomesService.applyPlaybookToIssue` — merge logic + persist column + non-applicable error
- `OutcomesService.revertOutcome` with `auto_reopen_on_revert=true` — parent flips; slot-rechecked-no-reopen case
- `webhooks/github` route handler — invalid sig → 401; replay → 200 idempotent; closed-but-not-merged → 200 ignored; matched outcome → 200 verified

Integration tests (in-memory paperclip):
- Template path: create template → create plan with templateId → assert contract materialized
- GitHub webhook: configure github_webhook_secret → POST signed payload → outcome flipped to verified → gate now passes
- Alias slot: contract with one alternative → verify primary → gate passes; OR verify alternative → gate passes; revert primary → gate stays passed
- Reopen-on-revert: verify contract → mark issue done → revert outcome with flag → assert issue back to in_progress + activityLog entry

E2E smoke (extend `scripts/smoke/tier1-e2e.sh`):
- POST template; POST plan with templateId; assert contract materialized
- POST signed GitHub webhook; assert outcome verified
- POST issues/apply-playbook; assert contract grew
- Verify outcome with auto_reopen flag; revert; assert issue reopened
- POST contract with alternative; verify alternative; assert slot satisfied without primary

Smoke gets ~30 lines longer (~50 total); still completes in ~30s.

## Phasing — implementation plan

Compact list — one task per phase, TDD discipline, same pattern as Plan 1:

```
1.  Migration 0094 — plan_templates, github_webhook_deliveries, columns
2.  outcome-kinds schema extensions — auto_reopen_on_revert + alternatives
3.  Pure helper: apply-template.ts
4.  Pure helper: apply-suggested-outcomes.ts
5.  Pure helper: alias-resolver.ts
6.  Pure helper: reopen-on-revert.ts (with slot-recheck)
7.  Pure helper: github-payload-parser.ts
8.  PlanTemplateService skeleton (CRUD + tenant gate)
9.  PlanService.createPlan + templateId path → materializeContract + span/metric
10. Predicate extension — allOutcomesVerified handles alias groups
11. OutcomesService.revertOutcome — wire auto-reopen path + outcomesEvents
12. OutcomesService.applyPlaybookToIssue + extend OrgLearningService.suggestPlaybooks
13. routes/plan-templates.ts (6 endpoints) + register
14. routes/webhooks.ts — POST /webhooks/github + rotate + deliveries-list + audit
15. routes/issues.ts extension — apply-playbook endpoint
16. routes/outcomes.ts extension — list response with alias context
17. UI: PlanTemplates page + PlanTemplatePicker + IssueDetail apply-playbook affordance
18. UI: CompanySettings Integrations tab + GitHubWebhookCard + OutcomesTab alias rendering
19. Memory subscriber adjustment — record auto-reopen events as procedural entries
20. OTel spans + 5 new metric streams wired
21. E2E smoke extension + ROADMAP/README close-out
```

~21 tasks total.

## Risks

- **GitHub PR ↔ issue linkage ambiguity.** Three fallbacks: PR title/body contains identifier (`LAK-735`); branch name matches; explicit `?issue_id=` query param. No-match returns 200 + audit row.
- **Webhook secret leak.** Same profile as `outcome_signal_secret` from Plan 1. Per-company rotation surface; secret shown once; admin-only rotation endpoint.
- **Auto-reopen storm.** A flaky external_signal source flips verified→reverted→verified. Mitigation: `auto_reopen_total` counter exposes the flap; operators can set the flag false on noisy sources; slot-recheck prevents reopen when alternative covers.
- **Playbook merge into in-flight contract.** `skip_existing` honors both pending and verified rows. `replace` only drops pending; verified stays as audit but stops gating.
- **Template versioning absent.** Plan 2 has no template revision chain. Edits don't propagate. Operators editing a template are told "this only affects future plans." Plan 3 if needed.
- **Alias slot edge case — verified alternative dropped from contract.** Operator removes an alternative; previously-verified alternative row stays as audit (P1 sticky-drop); primary reverts to pending if not already verified. UI surfaces: "Alternative was removed; primary outcome now blocking."

## Decisions

- **Templates as single-shot copy, not live binding.** Matches existing routine inheritance pattern. Live binding adds policy questions without clear win.
- **GitHub webhook is a thin adapter over `ingestExternalSignal`.** No new verifier primitive. One less divergence to maintain.
- **Per-integration secret (`github_webhook_secret`), not shared with `outcome_signal_secret`.** Better isolation; standard pattern for multi-source webhook ingestion.
- **Alternatives are sibling rows with `:alt:N` naming, not a separate `outcome_alternatives` join table.** Reuses existing `outcomes` table + partial-unique index + verifier path. Trade-off: predicate logic slightly more complex; schema stays narrow.
- **Auto-reopen-on-revert is per-kind in `required_meta`, not runtime parameter.** Declarative: contract IS the expectation.
- **Single-level OR for alternatives.** No nested `any_of`/`all_of`. Simpler design; sufficient for 80% case. Nested groups Plan 3.
- **Playbook apply is operator-driven, not automatic.** Existing `<memory>` prompt-prefix flow unchanged. Auto-apply is MAXIMIZER mode.

## Notes on deferred concerns

- Auto-archival of old verified rows — Plan 3.
- MCP-Resource adapter — couples to Memory P2; Plan 3.
- Linear / GitHub-Actions / generic-CI webhook adapters — pattern established by P2 GitHub adapter; Plan 3 extension.
- Cross-target outcomes — Plan 3.
- Live template binding — Plan 3 if requested.
- Template versioning — Plan 3 if requested.
- Nested alias groups (any_of / all_of) — Plan 3 if requested.
- GitHub App with installation tokens — enterprise milestone; separate Plan if needed.

## Open questions

1. **Issue↔PR linkage convention default.** Three fallbacks proposed. Default behavior for ambiguous cases is `result='no_match'` with audit. Confirm acceptable.
2. **Plan-template phase shapes.** `default_phases` column shipped in P2 schema; Plan 2 only uses `default_required_outcomes`. Should phase templating ship in P2 or wait for Deep-Planning Plan 2?
3. **GitHub webhook delivery audit retention.** Rows accumulate; no archival in P2. Default: keep forever; Plan 3 archival policy applies to both `outcomes` (verified rows) and `github_webhook_deliveries`.

---

*Draft: 2026-05-12. Review with: spec author + ops lead (for GitHub linkage convention) + Org Learning owner (for playbooks.suggested_outcomes schema). Plan document follows after approval.*
