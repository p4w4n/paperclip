# Enforced Outcomes — Plan 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural changes from `docs/superpowers/specs/2026-05-12-enforced-outcomes-plan-2-design.md`. This plan delivers: a new `plan_templates` table + `PlanTemplateService` for reusable contracts, a GitHub PR-merged webhook adapter that delegates to the existing `external_signal` verifier, `playbooks.suggested_outcomes` + operator-driven `apply-playbook` endpoint, per-kind opt-in reopen-on-revert with slot-recheck, and single-level outcome aliases (OR-of-outcomes via `:alt:N` sibling rows). Zero new verifier primitives — all five features layer on Plan 1's substrate.

**Architecture:** Five additive surfaces. None break the publish-subscribe boundary from Plan 1. The GitHub webhook is a thin adapter that calls the existing `ingestExternalSignal`. Templates materialize at plan-create time (single-shot copy, no live binding). Playbook application is operator-driven (auto-apply is MAXIMIZER-mode work). Reopen-on-revert is best-effort inside `revertOutcome` with a slot-recheck to suppress reopens when an alternative still covers the slot. Alternatives are materialized as sibling outcome rows with a `:alt:N` name suffix so the existing `outcomes_contract_uniq` partial-unique index continues to work.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres). Builds on Memory (Plan 1), Artifacts (Plan 1), Work Queues (Plan 1), Deep Planning (Plan 1), Automatic Organizational Learning (Plan 1), and Enforced Outcomes (Plan 1 + EO-19 bug fixes) all expected to be merged before this work starts.

**Scope split (this plan is Plan 2 of 3 for Enforced Outcomes):**

- ✅ This plan: `plan_templates` table + service; GitHub PR-merged webhook adapter; `playbooks.suggested_outcomes` + apply-playbook endpoint; per-kind `auto_reopen_on_revert` flag with slot-recheck; single-level outcome aliases (alternatives).
- ⏭ Plan 3: auto-archival of old verified rows; MCP-Resource adapter (after Memory Plan 2); Linear / GitHub-Actions / generic-CI webhook adapters; cross-target outcomes (plan-level satisfied by child issues); nested alias groups (any-of/all-of composition); live template binding; template versioning; GitHub App with installation tokens.

---

## File Structure

**Created:**

- `packages/db/src/schema/plan_templates.ts` — Drizzle schema for the `plan_templates` table.
- `packages/db/src/schema/github_webhook_deliveries.ts` — Drizzle schema for the audit table.
- `packages/db/src/migrations/0094_enforced_outcomes_plan_2.sql` — DDL. Hand-edited partial-WHERE indexes for `plan_templates_company_idx` and `plan_templates_company_name_uniq`.
- `packages/shared/src/outcome-kinds/contract-entry.ts` — shared `contractEntrySchema` zod shape with optional `alternatives`.
- `server/src/services/outcomes/alias-resolver.ts` — pure `isSlotSatisfied(rows, baseName)` + `expandContractEntryToRows(entry)` helpers.
- `server/src/services/outcomes/reopen-on-revert.ts` — pure `shouldReopenParent(revertedRow, siblingRows)` helper.
- `server/src/services/outcomes/apply-suggested-outcomes.ts` — pure `mergeSuggestedOutcomes(existing, suggested, strategy)` helper.
- `server/src/services/outcomes/webhooks/github.ts` — `ingestGithubWebhook` adapter delegating to `ingestExternalSignal`.
- `server/src/services/outcomes/webhooks/github-payload-parser.ts` — pure `parseGithubPrEvent(payload)` + `extractIssueIdentifier(payload, hint)` helpers.
- `server/src/services/templates/service.ts` — `PlanTemplateService` singleton (CRUD + tenant gate).
- `server/src/services/templates/apply-template.ts` — pure `projectTemplateToContract(template)` helper.
- `server/src/services/outcomes/__tests__/alias-resolver.test.ts`
- `server/src/services/outcomes/__tests__/reopen-on-revert.test.ts`
- `server/src/services/outcomes/__tests__/apply-suggested-outcomes.test.ts`
- `server/src/services/outcomes/__tests__/github-payload-parser.test.ts`
- `server/src/services/templates/__tests__/apply-template.test.ts`
- `server/src/services/templates/__tests__/service.test.ts`
- `server/src/routes/plan-templates.ts` — 6 endpoints (list / get / create / update / archive / restore).
- `server/src/routes/webhooks.ts` — POST `/webhooks/github`, rotate-secret, list-deliveries.
- `server/src/routes/__tests__/plan-templates.routes.test.ts`
- `server/src/routes/__tests__/webhooks-github.routes.test.ts`
- `ui/src/pages/PlanTemplates.tsx` — `/admin/plan-templates` list + edit + archive.
- `ui/src/components/PlanTemplatePicker.tsx` — reusable dropdown for create-plan modal.
- `ui/src/components/GitHubWebhookCard.tsx` — used in CompanySettings → Integrations.
- `ui/src/api/plan-templates.ts` — UI client.
- `ui/src/api/webhooks.ts` — UI client.
- `ui/src/components/__tests__/PlanTemplatePicker.test.tsx`
- `ui/src/pages/__tests__/PlanTemplates.test.tsx`

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `planTemplates`, `githubWebhookDeliveries`.
- `packages/db/src/schema/companies.ts` — add `githubWebhookSecret` text column.
- `packages/db/src/schema/playbooks.ts` — add `suggestedOutcomes` jsonb column.
- `packages/shared/src/outcome-kinds/index.ts` — re-export `contractEntrySchema`.
- `packages/shared/src/outcome-kinds/artifact-declared.ts` + 6 others — add optional `auto_reopen_on_revert: z.boolean().optional()`.
- `server/src/services/outcomes/service.ts` — extend `materializeContract` to expand alternatives into `:alt:N` rows; extend `revertOutcome` to fire `auto_reopen` path; add `applyPlaybookToIssue` method.
- `server/src/services/outcomes/predicate.ts` — `allOutcomesVerified` groups rows by slot base name and uses `isSlotSatisfied`.
- `server/src/services/outcomes/events.ts` — declare `'reverted'` event in the typed event map (was emitted in P1 but undeclared in the map).
- `server/src/services/outcomes/verifiers/external-signal.ts` — accept `idempotencyKey` from GitHub delivery_id (already supported; document the convention).
- `server/src/services/outcomes/metrics.ts` — add 5 new counters + ensure existing meter scope.
- `server/src/services/outcomes/spans.ts` — add 4 new span name constants.
- `server/src/services/plans/service.ts` — `createPlan` accepts optional `templateId`, materializes contract if provided.
- `server/src/services/learning/service.ts` — `suggestPlaybooks` return type gains `suggestedOutcomes`; new `getSuggestedOutcomesForPlaybook(id)` method.
- `server/src/routes/outcomes.ts` — list response gains `alternatives[]` + `slot_base_name` + `slot_satisfied`; revert response gains `parent_reopened` + `slot_still_satisfied`.
- `server/src/routes/plans.ts` — POST `/issues/:issueId/plans` accepts optional `templateId`.
- `server/src/routes/issues.ts` — new POST `/issues/:id/apply-playbook` handler.
- `server/src/app.ts` — register `planTemplatesRoutes` + `webhooksRoutes`; raw-body middleware already mounted from P1.
- `ui/src/App.tsx` — register `/admin/plan-templates` route via `lazyNamed`.
- `ui/src/components/OutcomesTab.tsx` — group rows by slot base name; render alias group as one collapsible row with `🔀 any-of` badge; show `🔁 reopens-on-revert` badge on rows whose `required_meta.auto_reopen_on_revert === true`.
- `ui/src/pages/IssueDetail.tsx` — `[Apply]` button on each suggested-playbook row (Memory/Playbooks panel) that opens a merge-strategy modal.
- `ui/src/pages/PlanDetail.tsx` — when creating a plan via the existing modal, expose `PlanTemplatePicker`.
- `ui/src/pages/CompanySettings.tsx` (or whichever file holds company settings — engineer should locate) — add an "Integrations" section embedding `GitHubWebhookCard`.
- `scripts/smoke/tier1-e2e.sh` — append Plan-2 block exercising template + webhook + apply-playbook + reopen-on-revert + alias slot.
- `ROADMAP.md` — refresh Enforced Outcomes paragraph: append Plan-2 close-out summary alongside Plan-1.
- `README.md` — flip the Tier-1 Foundations card for Enforced Outcomes to "Plan 1 + Plan 2 shipped"; mention GitHub webhook + templates one-liner.

**Migration:** `0094_enforced_outcomes_plan_2.sql`. Single migration. Two hand-edited partial-WHERE indexes (drizzle-kit doesn't emit them). Same pattern used by all prior Tier-1 migrations.

---

## Conventions used in this plan

Same as the previous Tier-1 plans (memory, artifacts, work-queues, deep-planning, organizational-learning, enforced-outcomes-foundation):

- **Test framework:** Vitest. Single file: `cd <pkg> && pnpm exec vitest run <path>` from inside the package directory (workspace tsx loader resolves correctly).
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate`, then rename generated file to `0094_enforced_outcomes_plan_2.sql` and update `meta/_journal.json` + rename `meta/0094_snapshot.json`. Then hand-edit partial-WHERE indexes at the end of the SQL file (drizzle-kit doesn't emit them). Same as 0089/0090/0091/0092/0093.
- **Commit style:** conventional commits matching existing history. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.
- **Branching off Plan 1 stack:** the first branch (`enforced-outcomes-p2/01-schema`) branches off `origin/enforced-outcomes/19-bug-fixes` (the tip of the EO Plan-1 work). After Plan-1 is merged to master, future Plan-2 tasks branch off the prior task's branch as usual.

---

## Task 1: schema + migration 0094

**Files:**

- Create: `packages/db/src/schema/plan_templates.ts`
- Create: `packages/db/src/schema/github_webhook_deliveries.ts`
- Create: `packages/db/src/migrations/0094_enforced_outcomes_plan_2.sql`
- Modify: `packages/db/src/schema/index.ts` — re-export new tables.
- Modify: `packages/db/src/schema/companies.ts` — add `githubWebhookSecret`.
- Modify: `packages/db/src/schema/playbooks.ts` — add `suggestedOutcomes`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/schema/__tests__/plan-templates-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planTemplates, githubWebhookDeliveries, companies, playbooks } from "../index.js";

describe("plan_templates schema", () => {
  it("exports planTemplates with expected columns", () => {
    expect(Object.keys(planTemplates)).toEqual(
      expect.arrayContaining([
        "id", "companyId", "name", "description",
        "defaultRequiredOutcomes", "defaultPhases", "archivedAt",
        "createdByUserId", "createdByAgentId",
        "createdAt", "updatedAt",
      ]),
    );
  });

  it("exports githubWebhookDeliveries with expected columns", () => {
    expect(Object.keys(githubWebhookDeliveries)).toEqual(
      expect.arrayContaining([
        "id", "companyId", "deliveryId", "eventType", "action",
        "prUrl", "outcomeId", "signatureValid", "result",
        "rawBodySha256", "receivedAt",
      ]),
    );
  });

  it("adds githubWebhookSecret column to companies", () => {
    expect(Object.keys(companies)).toContain("githubWebhookSecret");
  });

  it("adds suggestedOutcomes column to playbooks", () => {
    expect(Object.keys(playbooks)).toContain("suggestedOutcomes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/db test plan-templates-schema -v`
Expected: FAIL — module not found / columns missing.

- [ ] **Step 3: Create `packages/db/src/schema/plan_templates.ts`**

```ts
// plan_templates — reusable contracts for plans, materialized at plan creation
// (single-shot copy, no live binding). Mirrors routines.default_required_outcomes
// for the plan surface. EO Plan 2.

import { index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const planTemplates = pgTable(
  "plan_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    defaultRequiredOutcomes: jsonb("default_required_outcomes").$type<unknown[]>().notNull().default([]),
    defaultPhases: jsonb("default_phases").$type<unknown[]>().notNull().default([]),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Partial-WHERE indexes are hand-edited in the SQL migration.
);

export type PlanTemplateRow = typeof planTemplates.$inferSelect;
export type NewPlanTemplateRow = typeof planTemplates.$inferInsert;
```

- [ ] **Step 4: Create `packages/db/src/schema/github_webhook_deliveries.ts`**

```ts
// github_webhook_deliveries — audit table for GitHub PR-merged webhook ingestion.
// Replay protection via the (company_id, delivery_id) unique index;
// idempotency-key behavior at the verifier level reuses the same delivery_id.

import { boolean, index, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { outcomes } from "./outcomes.js";

export const githubWebhookDeliveries = pgTable(
  "github_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    prUrl: text("pr_url"),
    outcomeId: uuid("outcome_id").references(() => outcomes.id, { onDelete: "set null" }),
    signatureValid: boolean("signature_valid").notNull(),
    result: text("result").notNull(),  // 'verified' | 'no_match' | 'invalid_signature' | 'ignored'
    rawBodySha256: text("raw_body_sha256").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDeliveryUniq: uniqueIndex("github_webhook_deliveries_uniq").on(table.companyId, table.deliveryId),
    companyReceivedIdx: index("github_webhook_deliveries_company_idx").on(table.companyId, table.receivedAt),
  }),
);

export type GithubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferSelect;
```

- [ ] **Step 5: Add columns to existing tables**

In `packages/db/src/schema/companies.ts`, add `githubWebhookSecret: text("github_webhook_secret")` (nullable).

In `packages/db/src/schema/playbooks.ts`, add `suggestedOutcomes: jsonb("suggested_outcomes").$type<unknown[]>().notNull().default([])`.

- [ ] **Step 6: Re-export from schema barrel**

In `packages/db/src/schema/index.ts`, add:

```ts
export { planTemplates } from "./plan_templates.js";
export type { PlanTemplateRow, NewPlanTemplateRow } from "./plan_templates.js";
export { githubWebhookDeliveries } from "./github_webhook_deliveries.js";
export type { GithubWebhookDeliveryRow } from "./github_webhook_deliveries.js";
```

- [ ] **Step 7: Build schema package**

Run: `pnpm --filter @paperclipai/db build`
Expected: clean.

- [ ] **Step 8: Generate migration**

Run: `pnpm --filter @paperclipai/db generate`
Expected: a new `00XX_*.sql` migration + snapshot in `meta/`.

- [ ] **Step 9: Rename + journal**

Use `git mv` to rename to `0094_enforced_outcomes_plan_2.sql`. Update `tag` in `packages/db/src/migrations/meta/_journal.json` to `0094_enforced_outcomes_plan_2` and rename snapshot to `meta/0094_snapshot.json`. Same pattern as 0093.

- [ ] **Step 10: Hand-edit partial-WHERE indexes**

Append to `packages/db/src/migrations/0094_enforced_outcomes_plan_2.sql`:

```sql
-- Active templates per company (excluding archived).
CREATE INDEX "plan_templates_company_idx"
  ON "plan_templates" ("company_id") WHERE "archived_at" IS NULL;

-- Unique active template name per company.
CREATE UNIQUE INDEX "plan_templates_company_name_uniq"
  ON "plan_templates" ("company_id", "name") WHERE "archived_at" IS NULL;
```

- [ ] **Step 11: Verify the generated migration contains ONLY Plan-2 DDL**

Same check as EO-1: open `packages/db/src/migrations/0094_enforced_outcomes_plan_2.sql` and confirm it contains only:
- `CREATE TABLE plan_templates`
- `CREATE TABLE github_webhook_deliveries`
- `ALTER TABLE companies ADD COLUMN github_webhook_secret`
- `ALTER TABLE playbooks ADD COLUMN suggested_outcomes`
- The drizzle-emitted indexes (uniqueIndex github_webhook_deliveries_uniq + index github_webhook_deliveries_company_idx)
- The two hand-edited partial-WHERE indexes appended above

If drizzle-kit emits anything unrelated (schema drift from upstream), trim manually keeping only Plan-2 DDL (same situation that occurred in EO-1).

- [ ] **Step 12: Build + run tests**

Run: `pnpm --filter @paperclipai/db build && pnpm --filter @paperclipai/db test plan-templates-schema -v`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git checkout -b enforced-outcomes-p2/01-schema
git add packages/db/
git commit -m "feat(db): plan_templates + github_webhook_deliveries + EO-P2 columns (EO-P2-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/01-schema
```

---

## Task 2: outcome-kinds schema extensions (alternatives + auto_reopen_on_revert)

**Files:**

- Create: `packages/shared/src/outcome-kinds/contract-entry.ts`
- Modify: 7 per-kind files in `packages/shared/src/outcome-kinds/` — add optional `auto_reopen_on_revert`.
- Modify: `packages/shared/src/outcome-kinds/index.ts` — re-export `contractEntrySchema`.
- Modify: `packages/shared/src/outcome-kinds/__tests__/validators.test.ts` — extend with alternatives + reopen-flag tests.

- [ ] **Step 1: Write failing test**

Append to `packages/shared/src/outcome-kinds/__tests__/validators.test.ts`:

```ts
import { contractEntrySchema } from "../contract-entry.js";

describe("contractEntrySchema (Plan 2)", () => {
  it("accepts entry without alternatives", () => {
    const r = contractEntrySchema.safeParse({
      kind: "manual_signoff",
      requiredMeta: { name: "ack" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts entry with one alternative of a different kind", () => {
    const r = contractEntrySchema.safeParse({
      kind: "external_signal",
      requiredMeta: { name: "ci-pass", source: "github-actions" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: { required_role: "ops" } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects nested alternatives in an alternative (single-level OR only)", () => {
    const r = contractEntrySchema.safeParse({
      kind: "external_signal",
      requiredMeta: { name: "ci-pass" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: {}, alternatives: [{ kind: "manual_signoff", requiredMeta: {} }] },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("per-kind auto_reopen_on_revert flag (Plan 2)", () => {
  it("external_signal accepts auto_reopen_on_revert=true", () => {
    expect(validateRequiredMeta("external_signal", {
      name: "ci", source: "x", auto_reopen_on_revert: true,
    }).ok).toBe(true);
  });

  it("manual_signoff accepts auto_reopen_on_revert=false", () => {
    expect(validateRequiredMeta("manual_signoff", {
      name: "ack", auto_reopen_on_revert: false,
    }).ok).toBe(true);
  });

  it("auto_reopen_on_revert must be a boolean", () => {
    expect(validateRequiredMeta("external_signal", {
      name: "ci", source: "x", auto_reopen_on_revert: "yes",
    }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

```bash
cd packages/shared && pnpm exec vitest run src/outcome-kinds/__tests__/validators.test.ts
```
Expected: FAIL — `contractEntrySchema` not exported; `auto_reopen_on_revert` rejected.

- [ ] **Step 3: Create `packages/shared/src/outcome-kinds/contract-entry.ts`**

```ts
import { z } from "zod";
import { OUTCOME_KINDS } from "./index.js";

// Single-level OR alternative — same shape as the primary entry but without
// nested alternatives (no recursion). Validated via a sibling schema.
const contractAlternativeSchema = z.object({
  kind: z.enum(OUTCOME_KINDS as unknown as [string, ...string[]]),
  requiredMeta: z.record(z.unknown()),
});

export const contractEntrySchema = z.object({
  kind: z.enum(OUTCOME_KINDS as unknown as [string, ...string[]]),
  requiredMeta: z.record(z.unknown()),
  alternatives: z.array(contractAlternativeSchema).optional(),
});

export type ContractEntry = z.infer<typeof contractEntrySchema>;
export type ContractAlternative = z.infer<typeof contractAlternativeSchema>;
```

- [ ] **Step 4: Add `auto_reopen_on_revert` to each per-kind schema**

For each of the 7 files in `packages/shared/src/outcome-kinds/` (`artifact-declared.ts`, `plan-completed.ts`, `decision-recorded.ts`, `approval-granted.ts`, `exit-criteria-met.ts`, `manual-signoff.ts`, `external-signal.ts`), add:

```ts
auto_reopen_on_revert: z.boolean().optional(),
```

Example diff for `external-signal.ts`:

```ts
import { z } from "zod";

export const externalSignalSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  auto_reopen_on_revert: z.boolean().optional(),
});
```

Apply the same one-line addition to all 7 schemas.

- [ ] **Step 5: Re-export from barrel**

In `packages/shared/src/outcome-kinds/index.ts`, add:

```ts
export { contractEntrySchema, type ContractEntry, type ContractAlternative } from "./contract-entry.js";
```

- [ ] **Step 6: Run tests — verify pass**

```bash
cd packages/shared && pnpm exec vitest run src/outcome-kinds/__tests__/validators.test.ts
```
Expected: PASS — all 5+ new cases.

- [ ] **Step 7: Build**

```bash
pnpm --filter @paperclipai/shared build
```

- [ ] **Step 8: Commit**

```bash
git checkout -b enforced-outcomes-p2/02-outcome-kinds
git add packages/shared/src/outcome-kinds/
git commit -m "feat(shared): contract-entry schema + auto_reopen_on_revert (EO-P2-2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/02-outcome-kinds
```

---

## Task 3: pure helper — apply-template

**Files:**

- Create: `server/src/services/templates/apply-template.ts`
- Create: `server/src/services/templates/__tests__/apply-template.test.ts`

- [ ] **Step 1: Write failing test**

`server/src/services/templates/__tests__/apply-template.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectTemplateToContract } from "../apply-template.js";

describe("projectTemplateToContract", () => {
  it("deep-clones default_required_outcomes so callers can't mutate the template", () => {
    const template = {
      defaultRequiredOutcomes: [
        { kind: "manual_signoff", requiredMeta: { name: "ack" } },
      ],
    };
    const projected = projectTemplateToContract(template as any);
    expect(projected).toEqual(template.defaultRequiredOutcomes);
    expect(projected).not.toBe(template.defaultRequiredOutcomes);
    (projected[0] as any).requiredMeta.name = "MUTATED";
    expect((template.defaultRequiredOutcomes[0] as any).requiredMeta.name).toBe("ack");
  });

  it("returns empty array when default_required_outcomes is empty", () => {
    expect(projectTemplateToContract({ defaultRequiredOutcomes: [] } as any)).toEqual([]);
  });

  it("preserves alternatives field through the projection", () => {
    const template = {
      defaultRequiredOutcomes: [
        {
          kind: "external_signal",
          requiredMeta: { name: "ci", source: "x" },
          alternatives: [{ kind: "manual_signoff", requiredMeta: { required_role: "ops" } }],
        },
      ],
    };
    const projected = projectTemplateToContract(template as any);
    expect((projected[0] as any).alternatives).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/templates/__tests__/apply-template.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apply-template.ts`**

```ts
// Pure projection helper. Takes a PlanTemplateRow and returns a deep-cloned
// contract array suitable for OutcomesService.materializeContract.

import type { ContractEntry } from "@paperclipai/shared";

export interface PlanTemplateInput {
  defaultRequiredOutcomes: unknown[];
}

export function projectTemplateToContract(template: PlanTemplateInput): ContractEntry[] {
  // Deep clone via JSON round-trip — defaults are plain JSONB so this is sound.
  return JSON.parse(JSON.stringify(template.defaultRequiredOutcomes ?? [])) as ContractEntry[];
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/templates/__tests__/apply-template.test.ts
```
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/03-apply-template
git add server/src/services/templates/
git commit -m "feat(templates): pure projectTemplateToContract helper (EO-P2-3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/03-apply-template
```

---

## Task 4: pure helper — apply-suggested-outcomes (playbook merge)

**Files:**

- Create: `server/src/services/outcomes/apply-suggested-outcomes.ts`
- Create: `server/src/services/outcomes/__tests__/apply-suggested-outcomes.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { mergeSuggestedOutcomes } from "../apply-suggested-outcomes.js";

describe("mergeSuggestedOutcomes", () => {
  const existing = [
    { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
  ];
  const suggested = [
    { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }, // dup
    { kind: "approval_granted",  requiredMeta: { name: "risk", approval_kind: "risk" } },         // new
  ];

  it("skip_existing keeps existing entries; appends only new (kind, name)", () => {
    const r = mergeSuggestedOutcomes(existing, suggested, "skip_existing");
    expect(r.merged).toHaveLength(3);
    expect(r.added).toEqual([{ kind: "approval_granted", name: "risk" }]);
    expect(r.skippedExisting).toEqual([{ kind: "artifact_declared", name: "patch" }]);
  });

  it("replace drops existing and uses suggested verbatim", () => {
    const r = mergeSuggestedOutcomes(existing, suggested, "replace");
    expect(r.merged).toEqual(suggested);
    expect(r.added).toEqual([
      { kind: "artifact_declared", name: "patch" },
      { kind: "approval_granted", name: "risk" },
    ]);
    expect(r.skippedExisting).toEqual([]);
  });

  it("empty suggested with skip_existing is a no-op", () => {
    const r = mergeSuggestedOutcomes(existing, [], "skip_existing");
    expect(r.merged).toEqual(existing);
    expect(r.added).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/apply-suggested-outcomes.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apply-suggested-outcomes.ts`**

```ts
// Pure merger for playbook-suggested outcomes.
// Identity key for a contract entry is (kind, requiredMeta.name).

import type { ContractEntry } from "@paperclipai/shared";

export type MergeStrategy = "skip_existing" | "replace";

export interface MergeResult {
  merged: ContractEntry[];
  added: Array<{ kind: string; name: string }>;
  skippedExisting: Array<{ kind: string; name: string }>;
}

function keyOf(entry: ContractEntry): string {
  const name = (entry.requiredMeta as { name?: string })?.name ?? "";
  return `${entry.kind}::${name}`;
}

function nameOf(entry: ContractEntry): string {
  return (entry.requiredMeta as { name?: string })?.name ?? "";
}

export function mergeSuggestedOutcomes(
  existing: ContractEntry[],
  suggested: ContractEntry[],
  strategy: MergeStrategy,
): MergeResult {
  if (strategy === "replace") {
    return {
      merged: suggested,
      added: suggested.map((e) => ({ kind: e.kind, name: nameOf(e) })),
      skippedExisting: [],
    };
  }

  const existingKeys = new Set(existing.map(keyOf));
  const added: Array<{ kind: string; name: string }> = [];
  const skippedExisting: Array<{ kind: string; name: string }> = [];
  const toAppend: ContractEntry[] = [];

  for (const entry of suggested) {
    if (existingKeys.has(keyOf(entry))) {
      skippedExisting.push({ kind: entry.kind, name: nameOf(entry) });
    } else {
      added.push({ kind: entry.kind, name: nameOf(entry) });
      toAppend.push(entry);
    }
  }

  return { merged: [...existing, ...toAppend], added, skippedExisting };
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/apply-suggested-outcomes.test.ts
```
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/04-apply-suggested-outcomes
git add server/src/services/outcomes/apply-suggested-outcomes.ts server/src/services/outcomes/__tests__/apply-suggested-outcomes.test.ts
git commit -m "feat(outcomes): pure mergeSuggestedOutcomes helper (EO-P2-4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/04-apply-suggested-outcomes
```

---

## Task 5: pure helper — alias-resolver

**Files:**

- Create: `server/src/services/outcomes/alias-resolver.ts`
- Create: `server/src/services/outcomes/__tests__/alias-resolver.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { isSlotSatisfied, expandContractEntryToRows, baseNameOf, groupBySlot } from "../alias-resolver.js";

describe("isSlotSatisfied", () => {
  it("returns true when the primary row is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" }, status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(true);
  });

  it("returns true when only an alternative is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },         status: "pending"  },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },   status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(true);
  });

  it("returns false when no row in the slot is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },         status: "pending"  },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },   status: "pending"  },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });

  it("reverted rows do not satisfy a slot", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" }, status: "reverted" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });

  it("a verified row in a DIFFERENT slot does not satisfy", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "other" }, status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });
});

describe("baseNameOf", () => {
  it("strips :alt:N suffix", () => {
    expect(baseNameOf("ci")).toBe("ci");
    expect(baseNameOf("ci:alt:0")).toBe("ci");
    expect(baseNameOf("ci:alt:7")).toBe("ci");
  });

  it("handles names that themselves contain :alt:", () => {
    expect(baseNameOf("ops:alt:standin")).toBe("ops:alt:standin");
    expect(baseNameOf("ops:alt:standin:alt:0")).toBe("ops:alt:standin");
  });
});

describe("groupBySlot", () => {
  it("groups rows by slot base name", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },        status: "pending" },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },  status: "pending" },
      { kind: "manual_signoff",  requiredMeta: { name: "ack" },       status: "pending" },
    ];
    const groups = groupBySlot(rows as any);
    expect(Object.keys(groups).sort()).toEqual(["ack", "ci"]);
    expect(groups.ci).toHaveLength(2);
    expect(groups.ack).toHaveLength(1);
  });
});

describe("expandContractEntryToRows", () => {
  it("returns a single row when no alternatives", () => {
    const rows = expandContractEntryToRows({
      kind: "manual_signoff",
      requiredMeta: { name: "ack" },
    });
    expect(rows).toEqual([
      { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    ]);
  });

  it("expands N alternatives to N+1 rows with :alt:N suffix", () => {
    const rows = expandContractEntryToRows({
      kind: "external_signal",
      requiredMeta: { name: "ci", source: "x" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: { required_role: "ops" } },
        { kind: "approval_granted", requiredMeta: { approval_kind: "risk" } },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].requiredMeta.name).toBe("ci");
    expect(rows[1].requiredMeta.name).toBe("ci:alt:0");
    expect(rows[2].requiredMeta.name).toBe("ci:alt:1");
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/alias-resolver.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `alias-resolver.ts`**

```ts
// Pure helpers for outcome alias (OR-of-outcomes) materialization + resolution.
// Single-level OR only; nested groups deferred to Plan 3.

import type { ContractEntry, ContractAlternative } from "@paperclipai/shared";

interface OutcomeRowLike {
  kind: string;
  requiredMeta: { name: string; [k: string]: unknown };
  status: string;
}

const ALT_SUFFIX_RE = /:alt:\d+$/;

export function baseNameOf(name: string): string {
  return name.replace(ALT_SUFFIX_RE, "");
}

export function isSlotSatisfied(rows: OutcomeRowLike[], slotBaseName: string): boolean {
  return rows.some(
    (r) => r.status === "verified" && baseNameOf(r.requiredMeta.name) === slotBaseName,
  );
}

export function groupBySlot(rows: OutcomeRowLike[]): Record<string, OutcomeRowLike[]> {
  const out: Record<string, OutcomeRowLike[]> = {};
  for (const r of rows) {
    const base = baseNameOf(r.requiredMeta.name);
    (out[base] ??= []).push(r);
  }
  return out;
}

// Project one contract entry into N+1 outcome rows (1 primary + N alternatives).
// The primary keeps its requiredMeta as-is; alternatives get `:alt:N` name suffix.
export function expandContractEntryToRows(entry: ContractEntry): Array<{ kind: string; requiredMeta: Record<string, unknown> }> {
  const primaryName = (entry.requiredMeta as { name?: string }).name ?? "";
  const primary = {
    kind: entry.kind,
    requiredMeta: { ...entry.requiredMeta, name: primaryName },
  };
  const alts = (entry.alternatives ?? []).map((alt: ContractAlternative, idx: number) => ({
    kind: alt.kind,
    requiredMeta: { ...alt.requiredMeta, name: `${primaryName}:alt:${idx}` },
  }));
  return [primary, ...alts];
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/alias-resolver.test.ts
```
Expected: PASS (10+ cases).

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/05-alias-resolver
git add server/src/services/outcomes/alias-resolver.ts server/src/services/outcomes/__tests__/alias-resolver.test.ts
git commit -m "feat(outcomes): pure alias-resolver helpers (EO-P2-5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/05-alias-resolver
```

---

## Task 6: pure helper — reopen-on-revert (slot-rechecked)

**Files:**

- Create: `server/src/services/outcomes/reopen-on-revert.ts`
- Create: `server/src/services/outcomes/__tests__/reopen-on-revert.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { shouldReopenParent } from "../reopen-on-revert.js";

describe("shouldReopenParent", () => {
  it("returns true when flag is set and no sibling covers the slot", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: true },
      status: "reverted",
    };
    const siblings: any[] = [];
    expect(shouldReopenParent(reverted as any, siblings)).toEqual({ reopen: true });
  });

  it("returns false when flag is not set", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci" },  // no flag
      status: "reverted",
    };
    expect(shouldReopenParent(reverted as any, []).reopen).toBe(false);
  });

  it("returns false when an alternative is still verified (slot covered)", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: true },
      status: "reverted",
    };
    const siblings = [
      { kind: "manual_signoff", requiredMeta: { name: "ci:alt:0" }, status: "verified" },
    ];
    expect(shouldReopenParent(reverted as any, siblings)).toEqual({
      reopen: false, reason: "alt_covers",
    });
  });

  it("returns false when flag is explicitly false", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: false },
      status: "reverted",
    };
    expect(shouldReopenParent(reverted as any, []).reopen).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/reopen-on-revert.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `reopen-on-revert.ts`**

```ts
import { baseNameOf } from "./alias-resolver.js";

interface OutcomeRowLike {
  kind: string;
  requiredMeta: { name: string; auto_reopen_on_revert?: boolean; [k: string]: unknown };
  status: string;
}

export type ReopenDecision =
  | { reopen: true }
  | { reopen: false; reason?: "alt_covers" | "flag_false" };

export function shouldReopenParent(
  reverted: OutcomeRowLike,
  siblings: OutcomeRowLike[],
): ReopenDecision {
  if (reverted.requiredMeta.auto_reopen_on_revert !== true) {
    return { reopen: false, reason: "flag_false" };
  }
  const base = baseNameOf(reverted.requiredMeta.name);
  const altCovers = siblings.some(
    (s) => s.status === "verified" && baseNameOf(s.requiredMeta.name) === base,
  );
  if (altCovers) return { reopen: false, reason: "alt_covers" };
  return { reopen: true };
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/reopen-on-revert.test.ts
```
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/06-reopen-on-revert
git add server/src/services/outcomes/reopen-on-revert.ts server/src/services/outcomes/__tests__/reopen-on-revert.test.ts
git commit -m "feat(outcomes): pure shouldReopenParent helper with slot-recheck (EO-P2-6)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/06-reopen-on-revert
```

---

## Task 7: pure helper — github-payload-parser

**Files:**

- Create: `server/src/services/outcomes/webhooks/github-payload-parser.ts`
- Create: `server/src/services/outcomes/__tests__/github-payload-parser.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseGithubPrEvent, extractIssueIdentifier } from "../webhooks/github-payload-parser.js";

const samplePayload = (overrides: any = {}) => ({
  action: "closed",
  pull_request: {
    merged: true,
    number: 123,
    title: "LAK-735: fix the thing",
    body: "Resolves LAK-735.\n\nLong description.",
    head: { ref: "feature/lak-735-fix" },
    html_url: "https://github.com/example/repo/pull/123",
  },
  ...overrides,
});

describe("parseGithubPrEvent", () => {
  it("returns kind=merged for action=closed + merged=true", () => {
    expect(parseGithubPrEvent(samplePayload()).kind).toBe("merged");
  });

  it("returns kind=ignored for action=opened", () => {
    expect(parseGithubPrEvent(samplePayload({ action: "opened" })).kind).toBe("ignored");
  });

  it("returns kind=ignored for action=closed but merged=false", () => {
    expect(parseGithubPrEvent(samplePayload({
      pull_request: { ...samplePayload().pull_request, merged: false },
    })).kind).toBe("ignored");
  });

  it("returns kind=invalid_payload when pull_request is missing", () => {
    expect(parseGithubPrEvent({ action: "closed" } as any).kind).toBe("invalid_payload");
  });
});

describe("extractIssueIdentifier", () => {
  it("matches PAPERCLIP-style identifier in PR title", () => {
    expect(extractIssueIdentifier(samplePayload(), "LAK")).toBe("LAK-735");
  });

  it("matches identifier in PR body when title is plain", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "This resolves LAK-735.",
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });

  it("falls back to matching identifier in branch name", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "",
        head: { ref: "lak-735-fix" },
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });

  it("returns null when no identifier present anywhere", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "no identifier here",
        head: { ref: "feature/no-id" },
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBeNull();
  });

  it("is case-insensitive when matching against a known prefix", () => {
    const payload = samplePayload({
      pull_request: { ...samplePayload().pull_request, title: "fix lak-735" },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/github-payload-parser.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `github-payload-parser.ts`**

```ts
// Pure parser for GitHub pull_request webhook payloads.
// No DB access; isolates identifier extraction from the route handler.

export type ParseResult =
  | { kind: "merged"; prNumber: number; prUrl: string; title: string; body: string; branch: string }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid_payload"; reason: string };

export function parseGithubPrEvent(payload: unknown): ParseResult {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "invalid_payload", reason: "payload not an object" };
  }
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? p.action : "";
  const pr = (p.pull_request ?? null) as Record<string, unknown> | null;
  if (!pr) return { kind: "invalid_payload", reason: "missing pull_request" };

  if (action !== "closed") return { kind: "ignored", reason: `action=${action}` };
  if (pr.merged !== true) return { kind: "ignored", reason: "closed but not merged" };

  return {
    kind: "merged",
    prNumber: typeof pr.number === "number" ? pr.number : 0,
    prUrl: typeof pr.html_url === "string" ? pr.html_url : "",
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    branch: typeof (pr.head as { ref?: string })?.ref === "string" ? (pr.head as { ref: string }).ref : "",
  };
}

export function extractIssueIdentifier(payload: unknown, prefix: string): string | null {
  const parsed = parseGithubPrEvent(payload);
  if (parsed.kind !== "merged") return null;

  const re = new RegExp(`\\b${prefix}-(\\d+)\\b`, "i");
  for (const haystack of [parsed.title, parsed.body, parsed.branch]) {
    const match = haystack.match(re);
    if (match) return `${prefix}-${match[1]}`;
  }
  return null;
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/github-payload-parser.test.ts
```
Expected: PASS (10 cases).

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/07-github-payload-parser
git add server/src/services/outcomes/webhooks/github-payload-parser.ts server/src/services/outcomes/__tests__/github-payload-parser.test.ts
git commit -m "feat(outcomes): pure github-payload-parser (EO-P2-7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/07-github-payload-parser
```

---

## Task 8: PlanTemplateService skeleton (CRUD + tenant gate)

**Files:**

- Create: `server/src/services/templates/service.ts`
- Create: `server/src/services/templates/__tests__/service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { initializePlanTemplateService, getPlanTemplateService } from "../service.js";

const makeFakeDb = () => {
  const rows: any[] = [];
  let idCounter = 0;
  return {
    rows,
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { ...v, id: `tpl-${++idCounter}`, createdAt: new Date(), updatedAt: new Date() };
          rows.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async (_predicate: any) => rows.filter((r) => !r.archivedAt),
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            rows.forEach((r) => Object.assign(r, patch, { updatedAt: new Date() }));
            return rows;
          },
        }),
      }),
    }),
  };
};

describe("PlanTemplateService", () => {
  beforeEach(() => initializePlanTemplateService({ db: makeFakeDb() as any }));

  it("creates a template with defaultRequiredOutcomes", async () => {
    const svc = getPlanTemplateService();
    const t = await svc.create({ callerCompanyId: "co-1" }, {
      companyId: "co-1",
      name: "Strategy Rollout",
      defaultRequiredOutcomes: [{ kind: "manual_signoff", requiredMeta: { name: "ack" } }],
    });
    expect(t.id).toBeDefined();
    expect(t.name).toBe("Strategy Rollout");
  });

  it("listActive excludes archived", async () => {
    const svc = getPlanTemplateService();
    await svc.create({ callerCompanyId: "co-1" }, { companyId: "co-1", name: "A", defaultRequiredOutcomes: [] });
    const list = await svc.listActive({ callerCompanyId: "co-1" }, "co-1");
    expect(list).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/templates/__tests__/service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `service.ts`**

```ts
import { and, eq, isNull } from "drizzle-orm";
import { planTemplates, type PlanTemplateRow, type NewPlanTemplateRow } from "@paperclipai/db";

interface ServiceCtx { callerCompanyId: string }
interface ServiceDeps { db: any }

export class PlanTemplateNotFoundError extends Error {
  statusCode = 404;
  constructor(id: string) { super(`Plan template not found: ${id}`); }
}

export class PlanTemplateService {
  constructor(private deps: ServiceDeps) {}

  private assertTenant(ctx: ServiceCtx, companyId: string) {
    if (ctx.callerCompanyId !== companyId) {
      throw new Error("PlanTemplate tenant mismatch");
    }
  }

  async create(
    ctx: ServiceCtx,
    input: { companyId: string; name: string; description?: string;
             defaultRequiredOutcomes: unknown[]; defaultPhases?: unknown[];
             createdByUserId?: string; createdByAgentId?: string },
  ): Promise<PlanTemplateRow> {
    this.assertTenant(ctx, input.companyId);
    const [row] = await this.deps.db.insert(planTemplates).values({
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? null,
      defaultRequiredOutcomes: input.defaultRequiredOutcomes,
      defaultPhases: input.defaultPhases ?? [],
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
    } as NewPlanTemplateRow).returning();
    return row;
  }

  async update(
    ctx: ServiceCtx,
    id: string,
    patch: Partial<{ name: string; description: string; defaultRequiredOutcomes: unknown[]; defaultPhases: unknown[] }>,
  ): Promise<PlanTemplateRow> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    const [updated] = await this.deps.db.update(planTemplates).set({
      ...patch,
      updatedAt: new Date(),
    }).where(eq(planTemplates.id, id)).returning();
    return updated;
  }

  async archive(ctx: ServiceCtx, id: string): Promise<void> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    await this.deps.db.update(planTemplates).set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(planTemplates.id, id));
  }

  async restore(ctx: ServiceCtx, id: string): Promise<PlanTemplateRow> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    const [restored] = await this.deps.db.update(planTemplates)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(planTemplates.id, id))
      .returning();
    return restored;
  }

  async listActive(ctx: ServiceCtx, companyId: string): Promise<PlanTemplateRow[]> {
    this.assertTenant(ctx, companyId);
    return this.deps.db.select().from(planTemplates)
      .where(and(eq(planTemplates.companyId, companyId), isNull(planTemplates.archivedAt)));
  }

  async getById(ctx: ServiceCtx, id: string): Promise<PlanTemplateRow | null> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) return null;
    if (row.archivedAt) return null;  // treat archived as missing
    this.assertTenant(ctx, row.companyId);
    return row;
  }
}

let _instance: PlanTemplateService | null = null;
export function initializePlanTemplateService(deps: ServiceDeps): PlanTemplateService {
  _instance = new PlanTemplateService(deps);
  return _instance;
}
export function getPlanTemplateService(): PlanTemplateService {
  if (!_instance) throw new Error("PlanTemplateService not initialized");
  return _instance;
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/templates/__tests__/service.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/08-plan-template-service
git add server/src/services/templates/
git commit -m "feat(templates): PlanTemplateService CRUD with tenant gate (EO-P2-8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/08-plan-template-service
```

---

## Task 9: PlanService.createPlan — templateId materialization

**Files:**

- Modify: `server/src/services/plans/service.ts` — `createPlan` accepts optional `templateId`, calls template service + `materializeContract` + persists `requiredOutcomes` column on the new plan row.
- Create: `server/src/services/plans/__tests__/create-plan-template.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { PlanTemplateNotFoundError } from "../../templates/service.js";

// Use an in-process scaffold: initializeOutcomesService, initializePlanTemplateService,
// and initializePlanService — same pattern as Plan-1 integration tests under
// server/src/__tests__/issue-gate.test.ts. Adapt the existing test harness.

describe("PlanService.createPlan { templateId }", () => {
  it("materializes the template contract onto the new plan + persists the column", async () => {
    /* See server/src/__tests__/issue-gate.test.ts for the harness pattern; set
       up PlanTemplate row with defaultRequiredOutcomes, call createPlan with
       templateId, expect outcomes table to have N pending rows + plans.requiredOutcomes
       persisted with the template contract. */
  });

  it("throws PlanTemplateNotFoundError on missing template", async () => {
    /* createPlan with random uuid templateId, expect throw */
  });

  it("treats archived templates as missing", async () => {
    /* archive template, then createPlan with its id, expect throw */
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/plans/__tests__/create-plan-template.test.ts
```
Expected: FAIL — current `createPlan` doesn't accept `templateId`.

- [ ] **Step 3: Extend `createPlan` in `server/src/services/plans/service.ts`**

In the `CreatePlanInput` type, add `templateId?: string`. After the existing plan-row insert, before returning, add:

```ts
import { plans } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getPlanTemplateService } from "../templates/service.js";
import { getOutcomesService } from "../outcomes/service.js";
import { projectTemplateToContract } from "../templates/apply-template.js";

// inside createPlan, after the row insert returns `plan`:
if (input.templateId) {
  const tmpl = await getPlanTemplateService().getById(
    { callerCompanyId: input.companyId },
    input.templateId,
  );
  if (!tmpl) {
    throw new PlanTemplateNotFoundError(input.templateId);
  }
  const contract = projectTemplateToContract(tmpl);
  await this.deps.db
    .update(plans)
    .set({ requiredOutcomes: contract as unknown[] })
    .where(eq(plans.id, plan.id));
  await getOutcomesService().materializeContract(
    { kind: "plan", id: plan.id, companyId: input.companyId },
    contract as Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
  );
}
return plan;
```

Also re-export `PlanTemplateNotFoundError` from `templates/service.js` if not already.

- [ ] **Step 4: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/plans/__tests__/create-plan-template.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/09-create-plan-templateid
git add server/src/services/plans/service.ts server/src/services/plans/__tests__/create-plan-template.test.ts
git commit -m "feat(plans): createPlan accepts templateId; materializes contract (EO-P2-9)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/09-create-plan-templateid
```

---

## Task 10: predicate + materializeContract — alias-aware

**Files:**

- Modify: `server/src/services/outcomes/predicate.ts` — `allOutcomesVerified` groups by slot and uses `isSlotSatisfied`.
- Modify: `server/src/services/outcomes/service.ts` — `materializeContract` calls `expandContractEntryToRows` per contract entry so alternatives get sibling rows.
- Modify: `server/src/services/outcomes/__tests__/predicate.test.ts` — extend with alias cases.
- Modify: `server/src/services/outcomes/__tests__/service.test.ts` — extend `materializeContract` test with an alternative.

- [ ] **Step 1: Append failing tests**

In `predicate.test.ts`:

```ts
import { isSlotSatisfied, groupBySlot } from "../alias-resolver.js";

describe("allOutcomesVerified — alias awareness", () => {
  it("a slot satisfied by an alternative does not block the gate", async () => {
    /* fakeDb returns: ci (pending) + ci:alt:0 (verified). Expect allOutcomesVerified === true. */
  });

  it("a slot with NO verified row blocks the gate", async () => {
    /* fakeDb returns: ci (pending) + ci:alt:0 (pending). Expect allOutcomesVerified instanceof OutcomeRequiredError. */
  });

  it("the error body groups alias siblings under one entry", async () => {
    /* fakeDb returns: ci (pending) + ci:alt:0 (pending) + ack (pending).
       Expect error.body.pending has 2 entries (one for ci slot, one for ack), not 3 rows. */
  });
});
```

In `service.test.ts`:

```ts
describe("materializeContract — alternatives", () => {
  it("expands one entry with N alternatives into N+1 pending rows", async () => {
    /* materialize one contract entry with 2 alternatives, expect 3 rows in DB,
       names: name, name:alt:0, name:alt:1 */
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/predicate.test.ts src/services/outcomes/__tests__/service.test.ts
```
Expected: FAIL (new cases).

- [ ] **Step 3: Update `predicate.ts`**

Replace the inner logic of `allOutcomesVerified` so it groups rows by slot, then checks each slot:

```ts
import { groupBySlot, isSlotSatisfied } from "./alias-resolver.js";

export async function allOutcomesVerified(db: any, target: OutcomeTarget): Promise<true | OutcomeRequiredError> {
  const rows = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
  ));
  if (rows.length === 0) return true;

  const groups = groupBySlot(rows);
  const blocking: typeof rows = [];
  for (const [baseName, slotRows] of Object.entries(groups)) {
    if (!isSlotSatisfied(slotRows, baseName)) {
      // Surface the primary row (the one without :alt: suffix) for the error body.
      const primary = slotRows.find((r) => r.requiredMeta.name === baseName) ?? slotRows[0];
      blocking.push(primary);
    }
  }
  if (blocking.length === 0) return true;
  return new OutcomeRequiredError({
    target: { kind: target.kind, id: target.id },
    pending: blocking,
  });
}
```

- [ ] **Step 4: Update `materializeContract` in `service.ts`**

In the contract-diff path, before inserting, expand each contract entry to its sibling rows:

```ts
import { expandContractEntryToRows } from "./alias-resolver.js";

// inside materializeContract, replace the existing single-row insert loop with:
const allRowsToInsert: Array<{ kind: string; requiredMeta: Record<string, unknown> }> = [];
for (const entry of diff.toInsert) {
  for (const row of expandContractEntryToRows(entry as any)) {
    allRowsToInsert.push(row);
  }
}
// then insert each `row` as before
```

The diff helper (`diffContract`) doesn't change — it operates on (kind, name) keys and the sibling rows have distinct names by construction. Verify the diff still does the right thing when the contract entry's `alternatives` array changes (an alternative being added or removed produces row insert/delete deltas naturally).

- [ ] **Step 5: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/predicate.test.ts src/services/outcomes/__tests__/service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes-p2/10-alias-aware-predicate
git add server/src/services/outcomes/
git commit -m "feat(outcomes): alias-aware materializeContract + predicate (EO-P2-10)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/10-alias-aware-predicate
```

---

## Task 11: revertOutcome — auto-reopen path

**Files:**

- Modify: `server/src/services/outcomes/service.ts` — extend `revertOutcome` with auto-reopen path.
- Modify: `server/src/services/outcomes/events.ts` — add typed `'reverted'` event in the event map.
- Modify: `server/src/services/outcomes/__tests__/service.test.ts` — extend with reopen tests.

- [ ] **Step 1: Append failing test**

```ts
describe("revertOutcome — auto-reopen path", () => {
  it("reopens parent issue when auto_reopen_on_revert flag is true and no sibling covers slot", async () => {
    /* set up: issue 'i1' with verified outcome having auto_reopen_on_revert=true;
       issue.status = 'done'.
       revert the outcome.
       expect: issues.status = 'in_progress'; response { parent_reopened: true } */
  });

  it("does NOT reopen when an alternative still covers the slot", async () => {
    /* set up: ci slot with verified primary (flag=true) + verified alternative.
       revert the primary.
       expect: issue stays 'done'; response { parent_reopened: false, slot_still_satisfied: true } */
  });

  it("does NOT reopen when flag is false", async () => {
    /* set up: verified outcome without auto_reopen_on_revert.
       revert it. expect: issue stays 'done'. */
  });

  it("revert succeeds even if reopen fails (best-effort)", async () => {
    /* fakeDb that throws on the parent-update SQL.
       revert succeeds (returns the row); reopen-failed counter ticks. */
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `events.ts`**

Add `reverted` to the `OutcomesEventMap`:

```ts
export interface OutcomesEventMap {
  verified: { outcomeId: string; targetKind: string; targetId: string; companyId: string; kind: string; verifiedMeta?: unknown };
  reverted: { outcomeId: string; targetKind: string; targetId: string; companyId: string; kind: string; reason: string; parentReopened: boolean };
}
```

- [ ] **Step 4: Update `revertOutcome` in `service.ts`**

```ts
import { issues } from "@paperclipai/db";
import { plans } from "@paperclipai/db";
import { shouldReopenParent } from "./reopen-on-revert.js";
import { baseNameOf } from "./alias-resolver.js";
import { outcomesEvents } from "./events.js";
import { recordAutoReopen, recordAutoReopenFailed, recordAutoReopenSuppressed } from "./metrics.js";

async revertOutcome(outcomeId: string, reason: string): Promise<OutcomeRowLite & {
  parentReopened: boolean;
  slotStillSatisfied: boolean;
}> {
  // ... existing guarded UPDATE returning `reverted` ...

  // After successful revert, evaluate slot + reopen.
  let parentReopened = false;
  let slotStillSatisfied = false;
  try {
    // Load sibling rows for the same target + base name.
    const baseName = baseNameOf(reverted.requiredMeta.name as string);
    const siblings = await this.deps.db.select().from(outcomes).where(and(
      eq(outcomes.companyId, reverted.companyId),
      eq(outcomes.targetKind, reverted.targetKind),
      eq(outcomes.targetId, reverted.targetId),
    ));
    const siblingsExceptSelf = siblings.filter((s: any) => s.id !== reverted.id);

    const decision = shouldReopenParent(reverted as any, siblingsExceptSelf as any);
    if (decision.reopen) {
      // Reopen the parent.
      if (reverted.targetKind === "issue") {
        await this.deps.db.update(issues)
          .set({ status: "in_progress", completedAt: null, updatedAt: new Date() })
          .where(eq(issues.id, reverted.targetId));
      } else {
        await this.deps.db.update(plans)
          .set({ status: "in_progress", completedAt: null, updatedAt: new Date() })
          .where(eq(plans.id, reverted.targetId));
      }
      parentReopened = true;
      recordAutoReopen({ kind: reverted.kind, target_kind: reverted.targetKind });
    } else if (decision.reason === "alt_covers") {
      slotStillSatisfied = true;
      recordAutoReopenSuppressed({ reason: "alt_covers" });
    }
  } catch (err) {
    recordAutoReopenFailed({ kind: reverted.kind, target_kind: reverted.targetKind, reason_class: "exception" });
    // Best-effort; revert still succeeded.
  }

  outcomesEvents.emit("reverted", {
    outcomeId: reverted.id, targetKind: reverted.targetKind, targetId: reverted.targetId,
    companyId: reverted.companyId, kind: reverted.kind, reason, parentReopened,
  });

  return { ...reverted, parentReopened, slotStillSatisfied };
}
```

The `recordAutoReopen*` metric helpers are defined in Task 20. For Task 11, use temporary `void` stubs in `metrics.ts`:

```ts
export function recordAutoReopen(_l: any) {}
export function recordAutoReopenFailed(_l: any) {}
export function recordAutoReopenSuppressed(_l: any) {}
```

— these become real counter calls in Task 20.

- [ ] **Step 5: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes-p2/11-revert-auto-reopen
git add server/src/services/outcomes/
git commit -m "feat(outcomes): revertOutcome auto-reopen with slot-recheck (EO-P2-11)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/11-revert-auto-reopen
```

---

## Task 12: OutcomesService.applyPlaybookToIssue + suggestPlaybooks extension

**Files:**

- Modify: `server/src/services/outcomes/service.ts` — add `applyPlaybookToIssue(ctx, issueId, playbookId, mergeStrategy)`.
- Modify: `server/src/services/learning/service.ts` — `getSuggestedOutcomesForPlaybook(playbookId)`; extend `suggestPlaybooks` return.
- Modify: `server/src/services/outcomes/__tests__/service.test.ts` — extend with apply-playbook tests.

- [ ] **Step 1: Append failing tests**

```ts
import { PlaybookNotApplicableError } from "../service.js";

describe("OutcomesService.applyPlaybookToIssue", () => {
  it("merges suggested_outcomes into issue.required_outcomes with skip_existing", async () => {
    /* set up: playbook with 2 suggested_outcomes, issue with 1 existing matching outcome.
       call applyPlaybookToIssue.
       expect: contract length = 2 (1 existing + 1 new), addedCount = 1, skippedExisting.length = 1. */
  });

  it("replace strategy drops existing pending rows and reapplies", async () => {
    /* same setup, strategy=replace. expect contract length matches suggested. */
  });

  it("throws PlaybookNotApplicableError when applicability score is 0", async () => {
    /* mock matchPlaybookApplicability to return 0. expect throw. */
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Extend `OrgLearningService` in `server/src/services/learning/service.ts`**

```ts
async getSuggestedOutcomesForPlaybook(ctx: ServiceCtx, playbookId: string): Promise<ContractEntry[] | null> {
  const [row] = await this.deps.db.select({ id: playbooks.id, companyId: playbooks.companyId, suggestedOutcomes: playbooks.suggestedOutcomes })
    .from(playbooks).where(eq(playbooks.id, playbookId));
  if (!row) return null;
  this.assertTenant(ctx, row.companyId);
  return (row.suggestedOutcomes ?? []) as ContractEntry[];
}
```

In `suggestPlaybooks`, when assembling each suggestion include `suggestedOutcomesCount: (pb.suggestedOutcomes as unknown[]).length` so the UI can show a count.

- [ ] **Step 4: Add `applyPlaybookToIssue` to `OutcomesService` in `server/src/services/outcomes/service.ts`**

```ts
import { mergeSuggestedOutcomes, type MergeStrategy } from "./apply-suggested-outcomes.js";
import { matchPlaybookApplicability } from "../learning/applicability.js";
import { getOrgLearningService } from "../learning/service.js";

export class PlaybookNotApplicableError extends Error {
  statusCode = 422;
  constructor(playbookId: string, issueId: string) {
    super(`Playbook ${playbookId} not applicable to issue ${issueId}`);
  }
}

async applyPlaybookToIssue(
  ctx: OutcomesCtx,
  issueId: string,
  playbookId: string,
  mergeStrategy: MergeStrategy = "skip_existing",
): Promise<{ addedOutcomes: Array<{kind:string;name:string}>; skippedExisting: Array<{kind:string;name:string}>; newContractLength: number }> {
  // Load issue (for applicability context + current contract).
  const [issue] = await this.deps.db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) throw new Error(`issue not found: ${issueId}`);
  // ... tenant check ...
  // Load playbook + check applicability.
  const learning = getOrgLearningService();
  const suggested = await learning.getSuggestedOutcomesForPlaybook(ctx, playbookId);
  if (suggested === null) throw new Error(`playbook not found: ${playbookId}`);
  // ... matchPlaybookApplicability against issue. score 0 -> throw PlaybookNotApplicableError ...
  const existing = (issue.requiredOutcomes ?? []) as ContractEntry[];
  const merge = mergeSuggestedOutcomes(existing, suggested, mergeStrategy);
  await this.materializeContract(
    { kind: "issue", id: issue.id, companyId: issue.companyId },
    merge.merged as Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
  );
  await this.deps.db.update(issues).set({ requiredOutcomes: merge.merged as unknown[] })
    .where(eq(issues.id, issue.id));
  return { addedOutcomes: merge.added, skippedExisting: merge.skippedExisting, newContractLength: merge.merged.length };
}
```

- [ ] **Step 5: Run tests — verify pass**

```bash
cd server && pnpm exec vitest run src/services/outcomes/__tests__/service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes-p2/12-apply-playbook
git add server/src/services/outcomes/service.ts server/src/services/learning/service.ts server/src/services/outcomes/__tests__/service.test.ts
git commit -m "feat(outcomes): applyPlaybookToIssue + suggestedOutcomes API (EO-P2-12)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/12-apply-playbook
```

---

## Task 13: REST routes — plan-templates (6 endpoints)

**Files:**

- Create: `server/src/routes/plan-templates.ts`
- Create: `server/src/routes/__tests__/plan-templates.routes.test.ts`
- Modify: `server/src/app.ts` — register router.

- [ ] **Step 1: Write failing tests**

`plan-templates.routes.test.ts` covers all 6 endpoints with supertest-style assertions:

```ts
describe("/api/companies/:cid/plan-templates", () => {
  it("POST creates a template", async () => { /* 201 */ });
  it("GET lists active templates", async () => { /* 200 + array */ });
  it("GET /:id returns single", async () => { /* 200 */ });
  it("GET /:id 404 for archived", async () => { /* 404 */ });
  it("PATCH /:id updates", async () => { /* 200 */ });
  it("POST /:id/archive soft-deletes", async () => { /* 200 */ });
  it("POST /:id/restore un-archives", async () => { /* 200 */ });
});
```

(Use whatever in-process route-test harness exists — see `server/src/routes/__tests__/learning.routes.test.ts` for the pattern.)

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/routes/__tests__/plan-templates.routes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `routes/plan-templates.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { getPlanTemplateService, PlanTemplateNotFoundError } from "../services/templates/service.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default_required_outcomes: z.array(z.any()).default([]),
  default_phases: z.array(z.any()).default([]),
});

const patchBodySchema = createBodySchema.partial();

export function planTemplatesRoutes(_db: Db): Router {
  const r = Router();

  r.get("/companies/:cid/plan-templates", async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    const list = await getPlanTemplateService().listActive(
      { callerCompanyId: req.params.cid }, req.params.cid,
    );
    res.json({ templates: list });
  });

  r.get("/companies/:cid/plan-templates/:id", async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    try {
      const t = await getPlanTemplateService().getById({ callerCompanyId: req.params.cid }, req.params.id);
      if (!t) return res.status(404).json({ error: "not found" });
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates", validate(createBodySchema), async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    const body = req.body as z.infer<typeof createBodySchema>;
    const t = await getPlanTemplateService().create({ callerCompanyId: req.params.cid }, {
      companyId: req.params.cid,
      name: body.name,
      description: body.description,
      defaultRequiredOutcomes: body.default_required_outcomes,
      defaultPhases: body.default_phases,
      createdByUserId: (req as any).user?.id ?? null,
    });
    res.status(201).json(t);
  });

  r.patch("/companies/:cid/plan-templates/:id", validate(patchBodySchema), async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    try {
      const t = await getPlanTemplateService().update({ callerCompanyId: req.params.cid }, req.params.id, req.body);
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates/:id/archive", async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    try {
      await getPlanTemplateService().archive({ callerCompanyId: req.params.cid }, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates/:id/restore", async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    try {
      const t = await getPlanTemplateService().restore({ callerCompanyId: req.params.cid }, req.params.id);
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  return r;
}
```

- [ ] **Step 4: Register router in `server/src/app.ts`**

```ts
import { planTemplatesRoutes } from "./routes/plan-templates.js";
// inside the app composition where other routes are mounted:
api.use(planTemplatesRoutes(db));
```

Also initialize the service at boot in `server/src/index.ts`:

```ts
import { initializePlanTemplateService } from "./services/templates/service.js";
// after other initializers:
initializePlanTemplateService({ db });
```

- [ ] **Step 5: Run tests + type-check — verify pass**

```bash
cd server && pnpm exec vitest run src/routes/__tests__/plan-templates.routes.test.ts
pnpm --filter @paperclipai/server exec tsc --noEmit
```
Expected: PASS; no new tsc errors.

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes-p2/13-plan-templates-routes
git add server/src/routes/plan-templates.ts server/src/routes/__tests__/plan-templates.routes.test.ts server/src/app.ts server/src/index.ts
git commit -m "feat(routes): plan-templates CRUD + service boot wiring (EO-P2-13)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/13-plan-templates-routes
```

---

## Task 14: REST route — GitHub webhook (POST + rotate + deliveries-list)

**Files:**

- Create: `server/src/routes/webhooks.ts`
- Create: `server/src/services/outcomes/webhooks/github.ts`
- Create: `server/src/routes/__tests__/webhooks-github.routes.test.ts`
- Modify: `server/src/app.ts` — register router.

- [ ] **Step 1: Write failing tests** covering:
  - 401 on invalid signature
  - 200 ignored on `action=opened`
  - 200 ignored on `action=closed` but `merged=false`
  - 200 verified on `action=closed` + `merged=true` + matching outcome
  - 200 replay on duplicate `X-GitHub-Delivery`
  - 200 no_match when no contract entry matches the PR
  - 404 when company hasn't rotated a webhook secret
  - rotate endpoint generates fresh secret + admin-only access
  - deliveries list returns last 50 in reverse-chrono order

- [ ] **Step 2: Run — verify fail**

```bash
cd server && pnpm exec vitest run src/routes/__tests__/webhooks-github.routes.test.ts
```

- [ ] **Step 3: Implement `services/outcomes/webhooks/github.ts`**

```ts
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companies, githubWebhookDeliveries, issues, outcomes } from "@paperclipai/db";
import { verifyHmacSignature } from "../hmac.js";
import { parseGithubPrEvent, extractIssueIdentifier } from "./github-payload-parser.js";
import { ingestExternalSignal } from "../verifiers/external-signal.js";

export class GitHubWebhookSecretNotConfiguredError extends Error {
  statusCode = 404;
  constructor(companyId: string) { super(`No github_webhook_secret for company ${companyId}`); }
}

export interface IngestInput {
  companyId: string;
  deliveryId: string;
  eventType: string;
  signature: string;
  rawBody: string;
}

export async function ingestGithubWebhook(db: any, input: IngestInput): Promise<{ verified: boolean; matchedOutcomes: string[]; result: string; replay?: boolean }> {
  // Lookup secret
  const [co] = await db.select({ secret: companies.githubWebhookSecret, issuePrefix: companies.issuePrefix })
    .from(companies).where(eq(companies.id, input.companyId));
  if (!co?.secret) throw new GitHubWebhookSecretNotConfiguredError(input.companyId);

  const sigOk = verifyHmacSignature({ secret: co.secret, rawBody: input.rawBody, providedSig: input.signature });
  const rawBodySha256 = createHash("sha256").update(input.rawBody).digest("hex");

  // Replay protection — unique by (companyId, deliveryId)
  const [existing] = await db.select().from(githubWebhookDeliveries)
    .where(and(
      eq(githubWebhookDeliveries.companyId, input.companyId),
      eq(githubWebhookDeliveries.deliveryId, input.deliveryId),
    ));
  if (existing) {
    return { verified: existing.result === "verified", matchedOutcomes: existing.outcomeId ? [existing.outcomeId] : [], result: existing.result, replay: true };
  }

  if (!sigOk) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId, deliveryId: input.deliveryId, eventType: input.eventType,
      action: null, prUrl: null, outcomeId: null, signatureValid: false,
      result: "invalid_signature", rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "invalid_signature" };
  }

  // Parse payload
  let payload: unknown;
  try { payload = JSON.parse(input.rawBody); }
  catch { /* invalid json -> ignored */ payload = {}; }
  const parsed = parseGithubPrEvent(payload);

  if (parsed.kind !== "merged") {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId, deliveryId: input.deliveryId, eventType: input.eventType,
      action: (payload as any)?.action ?? null, prUrl: null, outcomeId: null,
      signatureValid: true, result: "ignored", rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "ignored" };
  }

  // Resolve to an issue via the company's issue prefix
  const identifier = extractIssueIdentifier(payload, co.issuePrefix);
  if (!identifier) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId, deliveryId: input.deliveryId, eventType: input.eventType,
      action: (payload as any).action, prUrl: parsed.prUrl, outcomeId: null,
      signatureValid: true, result: "no_match", rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "no_match" };
  }

  // Find the issue by identifier
  const [issue] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.identifier, identifier),
  ));
  if (!issue) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId, deliveryId: input.deliveryId, eventType: input.eventType,
      action: (payload as any).action, prUrl: parsed.prUrl, outcomeId: null,
      signatureValid: true, result: "no_match", rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "no_match" };
  }

  // Find pending external_signal outcomes on the issue with source='github*' or 'github-actions'/'github'
  const pendingExternal = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, input.companyId),
    eq(outcomes.targetKind, "issue"),
    eq(outcomes.targetId, issue.id),
    eq(outcomes.kind, "external_signal"),
    eq(outcomes.status, "pending"),
  ));
  const matched = pendingExternal.filter((o: any) => {
    const src = (o.requiredMeta?.source ?? "").toLowerCase();
    return src === "github" || src.startsWith("github");
  });

  const matchedOutcomes: string[] = [];
  for (const m of matched) {
    const r = await ingestExternalSignal(db, {
      outcomeId: m.id, companyId: input.companyId,
      rawBody: input.rawBody, signature: input.signature,
      idempotencyKey: input.deliveryId,
    });
    if (r.verified) matchedOutcomes.push(m.id);
  }

  await db.insert(githubWebhookDeliveries).values({
    companyId: input.companyId, deliveryId: input.deliveryId, eventType: input.eventType,
    action: (payload as any).action, prUrl: parsed.prUrl,
    outcomeId: matchedOutcomes[0] ?? null,
    signatureValid: true,
    result: matchedOutcomes.length > 0 ? "verified" : "no_match", rawBodySha256,
  });

  return { verified: matchedOutcomes.length > 0, matchedOutcomes, result: matchedOutcomes.length > 0 ? "verified" : "no_match" };
}
```

- [ ] **Step 4: Implement `routes/webhooks.ts`**

```ts
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { companies, githubWebhookDeliveries } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { ingestGithubWebhook, GitHubWebhookSecretNotConfiguredError } from "../services/outcomes/webhooks/github.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export function webhooksRoutes(db: Db): Router {
  const r = Router();

  // GitHub PR-merged webhook — no auth middleware, HMAC-verified inside ingest.
  r.post("/companies/:cid/webhooks/github", async (req, res) => {
    const deliveryId = req.header("X-GitHub-Delivery");
    const eventType = req.header("X-GitHub-Event") ?? "";
    const signature = req.header("X-Hub-Signature-256") ?? "";
    if (!deliveryId) return res.status(400).json({ error: "X-GitHub-Delivery required" });

    const rawBody = ((req as any).rawBody as Buffer | undefined)?.toString("utf-8") ?? "";

    try {
      const r2 = await ingestGithubWebhook(db, {
        companyId: req.params.cid, deliveryId, eventType,
        signature, rawBody,
      });
      const status = r2.result === "invalid_signature" ? 401 : 200;
      res.status(status).json(r2);
    } catch (e) {
      if (e instanceof GitHubWebhookSecretNotConfiguredError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  // Rotate secret — admin only
  r.post("/companies/:cid/webhooks/github/_secret/rotate", async (req, res) => {
    assertInstanceAdmin(req);
    const secret = `ghw_${randomBytes(32).toString("hex")}`;
    await db.update(companies).set({ githubWebhookSecret: secret }).where(eq(companies.id, req.params.cid));
    res.json({
      secret,
      instructions: `Configure this as the GitHub webhook secret at your repo's Settings → Webhooks`,
    });
  });

  // Deliveries list — for the integration card
  r.get("/companies/:cid/webhooks/github/deliveries", async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    const rows = await db.select().from(githubWebhookDeliveries)
      .where(eq(githubWebhookDeliveries.companyId, req.params.cid))
      .limit(50);
    res.json({ deliveries: rows });
  });

  return r;
}
```

- [ ] **Step 5: Register in `server/src/app.ts`**

```ts
import { webhooksRoutes } from "./routes/webhooks.js";
// alongside other routers
api.use(webhooksRoutes(db));
```

- [ ] **Step 6: Run tests + type-check — verify pass**

```bash
cd server && pnpm exec vitest run src/routes/__tests__/webhooks-github.routes.test.ts
pnpm --filter @paperclipai/server exec tsc --noEmit
```
Expected: PASS; no new errors.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes-p2/14-github-webhook
git add server/src/services/outcomes/webhooks/ server/src/routes/webhooks.ts server/src/routes/__tests__/webhooks-github.routes.test.ts server/src/app.ts
git commit -m "feat(outcomes): GitHub PR-merged webhook adapter (EO-P2-14)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/14-github-webhook
```

---

## Task 15: REST route — POST /issues/:id/apply-playbook

**Files:**

- Modify: `server/src/routes/issues.ts` — add new endpoint + extend zod input schema.
- Modify: `server/src/routes/__tests__/issues.routes.test.ts` (or matching) — test the new endpoint.

- [ ] **Step 1: Write failing test**

Test the path POST `/api/companies/:cid/issues/:id/apply-playbook` with body `{playbookId, mergeStrategy}`. Cases: 200 returns merge result; 422 on non-applicable; 404 on missing playbook; existing contract preserved in skip_existing.

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Implement handler**

Inside the existing `issuesRoutes(db)` factory in `server/src/routes/issues.ts`, add:

```ts
import { getOutcomesService } from "../services/outcomes/service.js";
import { PlaybookNotApplicableError } from "../services/outcomes/service.js";

router.post(
  "/companies/:cid/issues/:id/apply-playbook",
  validate(z.object({
    playbookId: z.string().uuid(),
    mergeStrategy: z.enum(["skip_existing", "replace"]).default("skip_existing"),
  })),
  async (req, res) => {
    assertCompanyAccess(req, req.params.cid);
    try {
      const r2 = await getOutcomesService().applyPlaybookToIssue(
        { callerCompanyId: req.params.cid },
        req.params.id,
        req.body.playbookId,
        req.body.mergeStrategy,
      );
      res.json({
        issueId: req.params.id,
        addedOutcomes: r2.addedOutcomes,
        skippedExisting: r2.skippedExisting,
        newContractLength: r2.newContractLength,
      });
    } catch (e) {
      if (e instanceof PlaybookNotApplicableError) return res.status(422).json({ error: e.message });
      throw e;
    }
  },
);
```

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/15-apply-playbook-route
git add server/src/routes/issues.ts server/src/routes/__tests__/
git commit -m "feat(routes): POST /issues/:id/apply-playbook (EO-P2-15)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/15-apply-playbook-route
```

---

## Task 16: routes/outcomes.ts — alias-aware list response + revert response

**Files:**

- Modify: `server/src/routes/outcomes.ts` — list response gains `alternatives[]`, `slot_base_name`, `slot_satisfied`; revert response gains `parent_reopened`, `slot_still_satisfied`.
- Modify: `server/src/routes/__tests__/outcomes.routes.test.ts` — extend tests.

- [ ] **Step 1: Append failing tests** to confirm:
  - List response includes `slot_base_name` + `slot_satisfied` + `alternatives[]`
  - Revert response includes `parent_reopened` + `slot_still_satisfied`

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Update list handler to compute alias context**

```ts
import { groupBySlot, baseNameOf, isSlotSatisfied } from "../services/outcomes/alias-resolver.js";

// Inside GET /api/companies/:cid/outcomes handler:
const rows = await getOutcomesService().listForTarget({ kind, id, companyId });
const groups = groupBySlot(rows);
const enriched = rows.map((r: any) => {
  const baseName = baseNameOf(r.requiredMeta.name);
  const slotRows = groups[baseName] ?? [];
  return {
    ...r,
    slot_base_name: baseName,
    slot_satisfied: isSlotSatisfied(slotRows, baseName),
    alternatives: r.requiredMeta.name === baseName
      ? slotRows.filter((s: any) => s.requiredMeta.name !== baseName)
      : [],
  };
});
res.json({ outcomes: enriched });
```

- [ ] **Step 4: Update revert handler to surface new fields**

```ts
const r2 = await getOutcomesService().revertOutcome(req.params.id, req.body?.reason ?? "operator");
res.json({
  ...r2,
  parent_reopened: r2.parentReopened,
  slot_still_satisfied: r2.slotStillSatisfied,
});
```

- [ ] **Step 5: Run tests + type-check — verify pass**

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes-p2/16-outcomes-route-alias-context
git add server/src/routes/outcomes.ts server/src/routes/__tests__/outcomes.routes.test.ts
git commit -m "feat(routes): outcomes list + revert surface alias context (EO-P2-16)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/16-outcomes-route-alias-context
```

---

## Task 17: UI — PlanTemplates page + PlanTemplatePicker + IssueDetail Apply

**Files:**

- Create: `ui/src/pages/PlanTemplates.tsx`
- Create: `ui/src/components/PlanTemplatePicker.tsx`
- Create: `ui/src/api/plan-templates.ts`
- Create: `ui/src/components/__tests__/PlanTemplatePicker.test.tsx`
- Create: `ui/src/pages/__tests__/PlanTemplates.test.tsx`
- Modify: `ui/src/App.tsx` — register `/admin/plan-templates` route.
- Modify: `ui/src/pages/IssueDetail.tsx` — `[Apply]` button on suggested playbooks panel.
- Modify: `ui/src/pages/PlanDetail.tsx` — expose `PlanTemplatePicker` in create-plan modal.

- [ ] **Step 1: Write failing tests** — render PlanTemplates page, expect table with templates from mocked API; render PlanTemplatePicker, expect dropdown of templates + selecting one calls onChange.

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Implement `api/plan-templates.ts`** — `listTemplates / get / create / update / archive / restore` matching the route handlers.

- [ ] **Step 4: Implement `PlanTemplates.tsx`** — table with name / outcomes count / last-used (computed client-side from plan create-time linkage) / actions. Modal for create + edit. Same component patterns as `/admin/learning`.

- [ ] **Step 5: Implement `PlanTemplatePicker.tsx`** — reusable dropdown. Props: `value: templateId | null`, `onChange: (templateId | null) => void`, `companyId`. Fetches active templates on mount.

- [ ] **Step 6: Wire into IssueDetail** — locate the existing Memory/Playbooks panel (or equivalent suggested-playbooks UI from Org Learning P1). Add `[Apply]` button next to each playbook entry that has `suggestedOutcomesCount > 0`. Click opens a modal: shows added/skipped preview + merge-strategy radio + confirm button that calls `POST /issues/:id/apply-playbook`.

- [ ] **Step 7: Wire into PlanDetail** — find the create-plan modal; add `PlanTemplatePicker` above the title field; pass selected templateId to the POST.

- [ ] **Step 8: Register `/admin/plan-templates`** in `ui/src/App.tsx`:

```tsx
const PlanTemplates = lazyNamed(() => import("./pages/PlanTemplates"), "PlanTemplates");
<Route path="/admin/plan-templates" element={<PlanTemplates />} />
```

- [ ] **Step 9: Run tests + tsc — verify pass**

- [ ] **Step 10: Commit**

```bash
git checkout -b enforced-outcomes-p2/17-ui-templates-and-playbook
git add ui/src/pages/PlanTemplates.tsx ui/src/components/PlanTemplatePicker.tsx ui/src/api/plan-templates.ts ui/src/pages/IssueDetail.tsx ui/src/pages/PlanDetail.tsx ui/src/App.tsx ui/src/components/__tests__/PlanTemplatePicker.test.tsx ui/src/pages/__tests__/PlanTemplates.test.tsx
git commit -m "feat(ui): plan templates page + picker + apply-playbook (EO-P2-17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/17-ui-templates-and-playbook
```

---

## Task 18: UI — CompanySettings Integrations + GitHubWebhookCard + OutcomesTab alias rendering

**Files:**

- Create: `ui/src/components/GitHubWebhookCard.tsx`
- Create: `ui/src/api/webhooks.ts`
- Modify: `ui/src/pages/CompanySettings.tsx` (or whichever holds settings — engineer locates) — add Integrations tab embedding the card.
- Modify: `ui/src/components/OutcomesTab.tsx` — group rows by slot; render alias group with `🔀 any-of` badge; show `🔁 reopens-on-revert` badge.

- [ ] **Step 1: Write failing tests** — render GitHubWebhookCard with mocked deliveries, expect status pill + last delivery rows; render OutcomesTab with alias rows, expect rendered as a single group with the badge.

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Implement `api/webhooks.ts`** — `rotateGithubSecret`, `listGithubDeliveries`.

- [ ] **Step 4: Implement `GitHubWebhookCard.tsx`** — status pill (Connected / Not configured); copy-able webhook URL; masked secret with Rotate button (opens modal showing new secret once with copy-to-clipboard + "I've configured this in GitHub" confirm); last 5 deliveries with verdict.

- [ ] **Step 5: Wire into CompanySettings page** — add a tab labeled "Integrations" embedding the card.

- [ ] **Step 6: Update `OutcomesTab.tsx`** — group by `slot_base_name`; each group renders one row with kind/name from primary + status pill = group's `slot_satisfied`; expand-toggle reveals each alternative row below. Add `🔀 any-of` chip when alternatives.length > 0; add `🔁 reopens-on-revert` chip when row's `required_meta.auto_reopen_on_revert === true`. Withdraw button on the primary; Sign-off button on each manual_signoff row.

- [ ] **Step 7: Run tests + tsc — verify pass**

- [ ] **Step 8: Commit**

```bash
git checkout -b enforced-outcomes-p2/18-ui-integrations-and-alias
git add ui/src/components/GitHubWebhookCard.tsx ui/src/components/OutcomesTab.tsx ui/src/api/webhooks.ts ui/src/pages/CompanySettings.tsx ui/src/components/__tests__/
git commit -m "feat(ui): GitHub integration card + OutcomesTab alias rendering (EO-P2-18)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/18-ui-integrations-and-alias
```

---

## Task 19: Memory subscriber — record auto-reopen events

**Files:**

- Modify: `server/src/services/memory/outcome-subscriber.ts` — listen for `outcomesEvents.reverted` with `parentReopened===true`; record a procedural entry.
- Modify: `server/src/services/memory/__tests__/outcome-subscriber.test.ts` — add test.

- [ ] **Step 1: Append failing test**

```ts
describe("memory outcome subscriber — auto-reopen events", () => {
  it("records a procedural memory entry when an outcome revert reopens the parent", async () => {
    /* spy on memory.write; emit outcomesEvents.reverted with parentReopened=true;
       expect write called with kind='procedural' and content mentions 'reopened' */
  });
});
```

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Extend `outcome-subscriber.ts`**

In the existing `onReverted` handler, add a branch when `e.parentReopened === true`:

```ts
onReverted: async (e) => {
  if (e.parentReopened) {
    try {
      await memory.write({ callerCompanyId: e.companyId }, {
        scope: { companyId: e.companyId },
        kind: "procedural",
        content: `Auto-reopened ${e.targetKind} ${e.targetId} after outcome revert: kind=${e.kind}, reason=${e.reason}.`,
      });
    } catch (err) { console.warn("[memory] auto-reopen ingest failed", { err }); }
  }
  // existing revert ingest remains
},
```

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes-p2/19-memory-subscriber
git add server/src/services/memory/outcome-subscriber.ts server/src/services/memory/__tests__/outcome-subscriber.test.ts
git commit -m "feat(memory): record auto-reopen as procedural entry (EO-P2-19)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/19-memory-subscriber
```

---

## Task 20: OTel spans + 5 new metric streams

**Files:**

- Modify: `server/src/services/outcomes/spans.ts` — add 4 new span name constants.
- Modify: `server/src/services/outcomes/metrics.ts` — replace the 3 stub helpers from Task 11 with real counter calls; add 5 new metric streams; ensure existing meter scope reused.
- Modify: `server/src/services/outcomes/__tests__/metrics.test.ts` — extend with 5 new metric existence checks.
- Wrap relevant service methods with `withSpan` in `service.ts` and the webhook route.

- [ ] **Step 1: Append failing test**

```ts
describe("outcomes metrics — Plan 2", () => {
  it("exposes the new counters", () => {
    expect(templateAppliedCounter).toBeDefined();
    expect(webhookReceivedCounter).toBeDefined();
    expect(webhookSignatureFailedCounter).toBeDefined();
    expect(playbookAppliedCounter).toBeDefined();
    expect(autoReopenCounter).toBeDefined();
    expect(autoReopenFailedCounter).toBeDefined();
    expect(aliasSlotSatisfiedCounter).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — verify fail**

- [ ] **Step 3: Extend `metrics.ts`**

```ts
export const templateAppliedCounter = meter.createCounter("paperclip_outcome_template_applied_total");
export const webhookReceivedCounter = meter.createCounter("paperclip_outcome_webhook_received_total");
export const webhookSignatureFailedCounter = meter.createCounter("paperclip_outcome_webhook_signature_failed_total");
export const playbookAppliedCounter = meter.createCounter("paperclip_outcome_playbook_applied_total");
export const autoReopenCounter = meter.createCounter("paperclip_outcome_auto_reopen_total");
export const autoReopenFailedCounter = meter.createCounter("paperclip_outcome_auto_reopen_failed_total");
export const autoReopenSuppressedCounter = meter.createCounter("paperclip_outcome_auto_reopen_suppressed_total");
export const aliasSlotSatisfiedCounter = meter.createCounter("paperclip_outcome_alias_slot_satisfied_total");

export function recordAutoReopen(labels: { kind: string; target_kind: string }) {
  autoReopenCounter.add(1, labels);
}
export function recordAutoReopenFailed(labels: { kind: string; target_kind: string; reason_class: string }) {
  autoReopenFailedCounter.add(1, labels);
}
export function recordAutoReopenSuppressed(labels: { reason: string }) {
  autoReopenSuppressedCounter.add(1, labels);
}
```

Then replace the stubs from Task 11 with these real calls.

- [ ] **Step 4: Add 4 new span constants to `spans.ts`**

```ts
export const SPAN_APPLY_TEMPLATE = "paperclip.outcome.apply_template";
export const SPAN_WEBHOOK_GITHUB = "paperclip.outcome.webhook_github";
export const SPAN_APPLY_PLAYBOOK = "paperclip.outcome.apply_playbook";
export const SPAN_AUTO_REOPEN = "paperclip.outcome.auto_reopen";
```

- [ ] **Step 5: Wrap relevant code paths**

In `service.ts`:
- Wrap the templateId materialization path in Task 9 with `withSpan(SPAN_APPLY_TEMPLATE, ...)`.
- Wrap `applyPlaybookToIssue` with `withSpan(SPAN_APPLY_PLAYBOOK, ...)`.
- Wrap the auto-reopen path in `revertOutcome` with `withSpan(SPAN_AUTO_REOPEN, ...)`.

In `routes/webhooks.ts`:
- Wrap `ingestGithubWebhook` calls with `withSpan(SPAN_WEBHOOK_GITHUB, ...)`.

After each successful counter trigger, increment the matching metric.

- [ ] **Step 6: Run tests + type-check**

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes-p2/20-otel-and-metrics
git add server/src/services/outcomes/metrics.ts server/src/services/outcomes/spans.ts server/src/services/outcomes/service.ts server/src/routes/webhooks.ts server/src/services/outcomes/__tests__/metrics.test.ts
git commit -m "feat(outcomes): OTel spans + 5 new metric streams (EO-P2-20)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/20-otel-and-metrics
```

---

## Task 21: E2E smoke + ROADMAP/README close-out

**Files:**

- Modify: `scripts/smoke/tier1-e2e.sh` — append Plan-2 block.
- Modify: `ROADMAP.md` — refresh Enforced Outcomes paragraph: append Plan-2 close-out summary.
- Modify: `README.md` — flip the Tier-1 Foundations card for Enforced Outcomes to mention Plan 2 features.

- [ ] **Step 1: Append Plan-2 block to `scripts/smoke/tier1-e2e.sh`** after the existing EO Plan-1 block:

```bash
# ---- EO Plan 2: templates ----
echo "[EO-P2] create plan_template"
TPL_ID=$(curl -fsSL -X POST "$API/api/companies/$CID/plan-templates" \
  -H 'content-type: application/json' \
  -d '{"name":"Strategy Rollout","default_required_outcomes":[
        {"kind":"manual_signoff","requiredMeta":{"name":"ops-ack"}}
      ]}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  templateId=$TPL_ID"

echo "[EO-P2] create plan using template"
PLAN_ID=$(curl -fsSL -X POST "$API/api/issues/$ISSUE_ID/plans" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"P2 template plan\",\"initialContent\":\"x\",\"templateId\":\"$TPL_ID\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['plan']['id'])")
echo "  planId=$PLAN_ID"

echo "[EO-P2] assert plan outcomes materialized"
PENDING=$(curl -fsSL "$API/api/companies/$CID/outcomes?target_kind=plan&target_id=$PLAN_ID" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['outcomes']))")
[ "$PENDING" = "1" ] || { echo "[EO-P2] expected 1 outcome, got $PENDING"; exit 1; }

# ---- EO Plan 2: GitHub webhook ----
echo "[EO-P2] rotate github webhook secret"
SECRET=$(curl -fsSL -X POST "$API/api/companies/$CID/webhooks/github/_secret/rotate" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")

echo "[EO-P2] POST signed pull_request.closed+merged webhook"
PAYLOAD='{"action":"closed","pull_request":{"merged":true,"number":1,"title":"LAK-1 fix","body":"","head":{"ref":"x"},"html_url":"x"}}'
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)
curl -fsSL -X POST "$API/api/companies/$CID/webhooks/github" \
  -H 'content-type: application/json' \
  -H "X-GitHub-Event: pull_request" -H "X-GitHub-Delivery: smoke-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$PAYLOAD"

# ---- EO Plan 2: alias slot ----
echo "[EO-P2] set issue contract with alias slot"
curl -fsSL -X PATCH "$API/api/issues/$ISSUE_ID" \
  -H 'content-type: application/json' \
  -d '{"requiredOutcomes":[{"kind":"manual_signoff","requiredMeta":{"name":"alias-test"},"alternatives":[{"kind":"manual_signoff","requiredMeta":{"required_role":"backup"}}]}]}'

echo "[EO-P2] verify alternative — expect slot satisfied"
ALT_ID=$(curl -fsSL "$API/api/companies/$CID/outcomes?target_kind=issue&target_id=$ISSUE_ID" \
  | python3 -c "import sys,json; outcomes=json.load(sys.stdin)['outcomes']; print([o['id'] for o in outcomes if o['required_meta'].get('name')=='alias-test:alt:0'][0])")
curl -fsSL -X POST "$API/api/companies/$CID/outcomes/$ALT_ID/signoff" \
  -H 'content-type: application/json' -d '{}'

echo "[EO-P2] smoke OK"
```

- [ ] **Step 2: Run the smoke against a live v2 instance** (if available) to confirm end-to-end:

```bash
PAPERCLIP_PORT=3100 PAPERCLIP_E2E_DIR=/tmp/paperclip-e2e-p2 scripts/smoke/tier1-e2e.sh
```

Expected: PASS through the Plan-2 block.

- [ ] **Step 3: Whole-repo build + tsc**

```bash
pnpm -r build && pnpm -r exec tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Update ROADMAP.md**

Find `### 🚧 Enforced Outcomes` and append a Plan-2 close-out paragraph after the Plan-1 paragraph:

```
Plan 2 (extensions) is in flight: plan_templates table + PlanTemplateService for reusable contracts materialized at plan creation; per-company GitHub PR-merged webhook adapter (HMAC-only auth, audited in github_webhook_deliveries) that delegates to the existing external_signal verifier — no new verifier primitive; playbooks.suggested_outcomes column + operator-driven apply-playbook endpoint that merges into an issue's required_outcomes (skip_existing default; replace strategy supported); per-kind opt-in `auto_reopen_on_revert` flag on contract entries with slot-recheck so alternatives suppress spurious reopens; single-level outcome aliases (OR-of-outcomes) materialized as :alt:N sibling rows with no new join table. Plan 3 layers on auto-archival, MCP-Resource adapter (after Memory Plan 2), Linear/CI webhook adapters, cross-target outcomes, nested alias groups, live template binding, template versioning, and GitHub App with installation tokens.
```

- [ ] **Step 5: Update README.md**

In the Tier-1 Foundations panel, expand the Enforced Outcomes card to mention Plan 2 features (templates / GitHub webhook / playbook apply / OR-of-outcomes / reopen-on-revert).

- [ ] **Step 6: Commit + push**

```bash
git checkout -b enforced-outcomes-p2/21-smoke-and-roadmap
git add scripts/smoke/tier1-e2e.sh ROADMAP.md README.md
git commit -m "feat(outcomes): EO Plan 2 e2e smoke + ROADMAP/README close-out (EO-P2-21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes-p2/21-smoke-and-roadmap
```

---

## Self-review notes (informational, not a step)

After all 21 tasks land:
- `pnpm -r build && pnpm -r test && pnpm -r exec tsc --noEmit` passes.
- `scripts/smoke/tier1-e2e.sh` includes the Plan-2 block and exits 0.
- `/admin/plan-templates` admin page renders.
- Creating a plan with `templateId` materializes the contract.
- POSTing a signed GitHub `pull_request.closed+merged` webhook verifies the matching outcome.
- `POST /issues/:id/apply-playbook` merges a playbook's `suggested_outcomes` into the issue's contract.
- A revert with `auto_reopen_on_revert=true` flips the parent back to `in_progress` — UNLESS an alternative still covers the slot.
- A contract slot with one or more alternatives is satisfied by ANY of them; the gate respects this.

Plan-2 ships ~21 commits across 21 branches stacked off the EO Plan-1 stack tip (`enforced-outcomes/19-bug-fixes`).
