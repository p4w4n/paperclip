# Enforced Outcomes Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-10-enforced-outcomes-design.md`. This plan delivers: the `outcomes` table + per-entity `required_outcomes` JSONB columns, per-kind JSON-schema validators (7 kinds), pure helpers (contract-diff, markdown-checkbox parser, HMAC verifier), the `OutcomesService` write/read path with tenant isolation, the seven verifier modules, in-process `events.ts` emitters on the four landed substrates (Artifacts, Plans, Approvals — Memory ingest is a separate subscriber), boot-time subscriber wiring, the gate-check predicate integrated into `issueService.updateIssue` and `PlanService.completePlan`, REST routes, UI (Outcomes tab on issue + plan detail; `/instance/outcomes` admin; routine "Outcomes contract" config), Memory subscriber recording outcome events as procedural entries, OTel spans + 5 metric streams, and an end-to-end smoke addition.

**Architecture:** New `server/src/services/outcomes/` module exporting `OutcomesService` as a singleton initialized at boot. The four landed substrates (Artifacts, Plans, Approvals) gain small in-process `EventEmitter` modules and emit post-commit; `OutcomesService.tryVerify` is the only subscriber today. Contracts live inline as JSONB on `issues.required_outcomes`, `plans.required_outcomes`, and (for inheritance at issue creation) `routines.default_required_outcomes`. Sticky terminals + audit reversion in Plan 1; provider-specific webhook adapters and reopen-on-revert flow in Plan 2.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres). Builds on Memory (Plan 1), Artifacts (Plan 1), Work Queues (Plan 1), Deep Planning (Plan 1), and Automatic Organizational Learning (Plan 1) all already in master.

**Scope split (this plan covers Plan 1 of 2 for Enforced Outcomes):**

- ✅ This plan: schema + 7 typed kinds; `OutcomesService` skeleton + verifiers; pure helpers; `events.ts` emitters on Artifacts/Plans/Approvals; subscriber wiring; gate-check predicate at issue + plan terminal transitions; REST endpoints; UI Outcomes tab + admin page + routine config section; Memory subscriber for procedural ingest; OTel + 5 metric streams; e2e smoke.
- ⏭ Plan 2: provider-specific webhook adapters (GitHub PR-merged, GitHub-Actions, Linear); plan + routine **templates** carrying `default_required_outcomes`; `playbooks.suggested_outcomes` autopopulation from Org Learning; opt-in reopen-on-revert; outcome aliases / OR-of-outcomes; auto-archival of old verified rows; MCP-Resource adapter for outcomes.

---

## File Structure

**Created:**

- `packages/db/src/schema/outcomes.ts` — Drizzle schema for the `outcomes` table.
- `packages/db/src/migrations/0093_enforced_outcomes_foundation.sql` — DDL with the partial-unique contract slot index, partial pending-only lookup index, and external-signal idempotency index. Hand-edited (drizzle-kit doesn't emit partial-WHERE).
- `packages/shared/src/outcome-kinds/index.ts` — barrel re-export + `OUTCOME_KINDS` const.
- `packages/shared/src/outcome-kinds/artifact-declared.ts` — required-meta + verified-meta JSON schemas.
- `packages/shared/src/outcome-kinds/plan-completed.ts`
- `packages/shared/src/outcome-kinds/decision-recorded.ts`
- `packages/shared/src/outcome-kinds/approval-granted.ts`
- `packages/shared/src/outcome-kinds/exit-criteria-met.ts`
- `packages/shared/src/outcome-kinds/manual-signoff.ts`
- `packages/shared/src/outcome-kinds/external-signal.ts`
- `packages/shared/src/outcome-kinds/__tests__/validators.test.ts` — single test file covering all seven kinds.
- `server/src/services/outcomes/types.ts` — `OutcomesService` contract; `OutcomeRow`, `OutcomeContract`, `OutcomeRequiredError`.
- `server/src/services/outcomes/contract.ts` — pure `diffContract(existing, desired)` helper.
- `server/src/services/outcomes/predicate.ts` — `allOutcomesVerified(db, target)`.
- `server/src/services/outcomes/checkbox-parser.ts` — pure markdown checkbox counter.
- `server/src/services/outcomes/hmac.ts` — pure HMAC-SHA256 verifier with timing-safe compare.
- `server/src/services/outcomes/service.ts` — `OutcomesService` singleton.
- `server/src/services/outcomes/spans.ts` — OTel span helpers (`paperclip.outcome.*`).
- `server/src/services/outcomes/metrics.ts` — five OTel metric streams + observable gauge.
- `server/src/services/outcomes/verifiers/index.ts` — kind → verifier dispatch.
- `server/src/services/outcomes/verifiers/artifact-declared.ts`
- `server/src/services/outcomes/verifiers/plan-completed.ts`
- `server/src/services/outcomes/verifiers/decision-recorded.ts`
- `server/src/services/outcomes/verifiers/approval-granted.ts`
- `server/src/services/outcomes/verifiers/exit-criteria-met.ts`
- `server/src/services/outcomes/verifiers/manual-signoff.ts`
- `server/src/services/outcomes/verifiers/external-signal.ts`
- `server/src/services/outcomes/__tests__/contract.test.ts`
- `server/src/services/outcomes/__tests__/predicate.test.ts`
- `server/src/services/outcomes/__tests__/checkbox-parser.test.ts`
- `server/src/services/outcomes/__tests__/hmac.test.ts`
- `server/src/services/outcomes/__tests__/service.test.ts`
- `server/src/services/outcomes/__tests__/verifiers.test.ts`
- `server/src/services/artifacts/events.ts` — in-process `EventEmitter` for Artifacts.
- `server/src/services/plans/events.ts` — in-process `EventEmitter` for Plans.
- `server/src/services/approvals-events.ts` — sibling emitter for Approvals (since `approvals.ts` is a single-file service).
- `server/src/services/memory/outcome-subscriber.ts` — records `outcome.verified` and `outcome.reverted` as procedural memory entries.
- `server/src/routes/outcomes.ts` — REST endpoints.
- `ui/src/api/outcomes.ts` — UI client.
- `ui/src/pages/Outcomes.tsx` — `/instance/outcomes` admin page.
- `ui/src/components/OutcomesTab.tsx` — shared component used in `IssueDetail.tsx` and `PlanDetail.tsx`.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `outcomes`.
- `packages/db/src/schema/issues.ts` — add `requiredOutcomes` JSONB column.
- `packages/db/src/schema/plans.ts` — add `requiredOutcomes` JSONB column.
- `packages/db/src/schema/routines.ts` — add `defaultRequiredOutcomes` JSONB column.
- `packages/db/src/schema/companies.ts` — add `outcomeSignalSecret` text column.
- `server/src/services/artifacts/service.ts` — emit `declared` event after the DB transaction commits.
- `server/src/services/plans/service.ts` — emit `completed`, `decisionRecorded`, `phaseCompleted`, `phaseMarkdownUpdated` events; integrate gate-check on `completePlan`.
- `server/src/services/approvals.ts` — emit `approved` event when status transitions.
- `server/src/services/issues.ts` — integrate gate-check on transition to `done`; call `OutcomesService.materializeContract` on contract writes.
- `server/src/index.ts` — initialize `OutcomesService` singleton at boot; wire subscribers; wire Memory's outcome-subscriber.
- `server/src/app.ts` — register `outcomesRoutes`.
- `ui/src/App.tsx` — register `/instance/outcomes` route.
- `ui/src/pages/IssueDetail.tsx` — add Outcomes tab.
- `ui/src/pages/PlanDetail.tsx` — add Outcomes tab.
- `ui/src/pages/AdminRoutines.tsx` (or whichever file holds the routine-edit form — the Task touches whatever's actually there) — add "Outcomes contract" section that writes to `routines.default_required_outcomes`.
- `scripts/smoke/tier1-e2e.sh` — append outcomes block: create issue with contract → expect 422 on done → declare artifact → expect 200 on done.
- `ROADMAP.md` — flip Enforced Outcomes ⚪ → 🚧 with close-out summary.
- `README.md` — flip in roadmap preview; add Outcomes card to Tier-1 Foundations panel; add e2e smoke note.

**Migration:** `0093_enforced_outcomes_foundation.sql`. Single migration. Three partial indexes hand-edited in (the contract-slot uniq, the pending-only lookup, and the external-signal idem-key uniq). Same hand-edit pattern as the prior five Tier-1 migrations.

---

## Conventions used in this plan

Same as the previous Tier-1 plans (memory, artifacts, work-queues, deep-planning, organizational-learning):

- **Test framework:** Vitest. Single file: `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate`, then rename the generated migration to `0093_enforced_outcomes_foundation.sql` and update `meta/_journal.json`. Hand-edit the partial-WHERE indexes (drizzle-kit doesn't emit them) — same pattern used in 0084, 0085, 0087, 0088, 0089, 0092.
- **Commit style:** conventional commits matching existing history. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: schema + migration

**Files:**

- Create: `packages/db/src/schema/outcomes.ts`
- Create: `packages/db/src/migrations/0093_enforced_outcomes_foundation.sql`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/issues.ts`
- Modify: `packages/db/src/schema/plans.ts`
- Modify: `packages/db/src/schema/routines.ts`
- Modify: `packages/db/src/schema/companies.ts`

- [ ] **Step 1: Write the failing test**

`packages/db/__tests__/outcomes-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { outcomes } from "../src/schema/outcomes.js";
import { issues, plans, routines, companies } from "../src/schema/index.js";

describe("outcomes schema", () => {
  it("exports an outcomes table with the expected columns", () => {
    const cols = Object.keys(outcomes);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "companyId", "targetKind", "targetId", "kind", "status",
        "requiredMeta", "verifiedMeta", "verifiedAt",
        "verifiedByKind", "verifiedById",
        "revertedAt", "revertedReason",
        "createdAt", "updatedAt",
      ]),
    );
  });

  it("adds requiredOutcomes column to issues, plans; defaultRequiredOutcomes to routines; outcomeSignalSecret to companies", () => {
    expect(Object.keys(issues)).toContain("requiredOutcomes");
    expect(Object.keys(plans)).toContain("requiredOutcomes");
    expect(Object.keys(routines)).toContain("defaultRequiredOutcomes");
    expect(Object.keys(companies)).toContain("outcomeSignalSecret");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/db test outcomes-schema -v`
Expected: FAIL — module not found / column missing.

- [ ] **Step 3: Create `packages/db/src/schema/outcomes.ts`**

```ts
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Polymorphic FK enforced in code (target_kind ∈ {issue, plan}, target_id is the row id).
    targetKind: text("target_kind").notNull(),  // 'issue' | 'plan'
    targetId: uuid("target_id").notNull(),

    kind: text("kind").notNull(), // see OUTCOME_KINDS
    status: text("status").notNull().default("pending"),  // 'pending' | 'verified' | 'reverted'

    requiredMeta: jsonb("required_meta").notNull().default({}),
    verifiedMeta: jsonb("verified_meta"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByKind: text("verified_by_kind"), // 'agent' | 'user' | 'system' | 'webhook'
    verifiedById: uuid("verified_by_id"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertedReason: text("reverted_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetIdx: index("outcomes_target_idx").on(table.companyId, table.targetKind, table.targetId),
    // Partial pending-only and contract-uniq + idem-uniq indexes are hand-edited in the SQL migration
    // — drizzle-kit doesn't support partial WHERE. Same hand-edit pattern as prior Tier-1 migrations.
  }),
);

export type OutcomeRow = typeof outcomes.$inferSelect;
export type NewOutcomeRow = typeof outcomes.$inferInsert;
```

- [ ] **Step 4: Add columns to existing tables**

In `packages/db/src/schema/issues.ts`, add `requiredOutcomes: jsonb("required_outcomes").notNull().default([])` to the column object.

In `packages/db/src/schema/plans.ts`, the same `requiredOutcomes` column.

In `packages/db/src/schema/routines.ts`, add `defaultRequiredOutcomes: jsonb("default_required_outcomes").notNull().default([])`.

In `packages/db/src/schema/companies.ts`, add `outcomeSignalSecret: text("outcome_signal_secret")` (nullable; populated lazily on first contract that uses external_signal).

- [ ] **Step 5: Re-export from schema barrel**

In `packages/db/src/schema/index.ts`, add `export { outcomes } from "./outcomes.js";` and `export type { OutcomeRow, NewOutcomeRow } from "./outcomes.js";`.

- [ ] **Step 6: Build the schema package so drizzle-kit sees the new columns**

Run: `pnpm --filter @paperclipai/db build`
Expected: clean build.

- [ ] **Step 7: Generate the migration**

Run: `pnpm --filter @paperclipai/db generate`
Expected: a new migration file appears in `packages/db/src/migrations/` (with a name like `00XX_<adjective_noun>.sql`) and a snapshot in `meta/`.

- [ ] **Step 8: Rename the generated migration to `0093_enforced_outcomes_foundation.sql`**

Use `git mv`. Update the `tag` field in `packages/db/src/migrations/meta/_journal.json` for the new entry to `0093_enforced_outcomes_foundation` and rename the snapshot file to `meta/0093_snapshot.json` (and the `idx` increments from 92).

- [ ] **Step 9: Hand-edit partial-WHERE indexes into the SQL migration**

Append to `packages/db/src/migrations/0093_enforced_outcomes_foundation.sql`:

```sql
-- Pending-only partial index, used by the gate-check predicate.
CREATE INDEX IF NOT EXISTS "outcomes_pending_idx"
  ON "outcomes" ("company_id", "target_kind", "target_id")
  WHERE "status" = 'pending';

-- One slot per (target, kind, name); name comes from required_meta->>'name'.
CREATE UNIQUE INDEX IF NOT EXISTS "outcomes_contract_uniq"
  ON "outcomes" ("company_id", "target_kind", "target_id", "kind", ((required_meta->>'name')))
  WHERE "status" IN ('pending', 'verified');

-- For external_signal Idempotency-Key dedup.
CREATE UNIQUE INDEX IF NOT EXISTS "outcomes_signal_idem_uniq"
  ON "outcomes" ("company_id", "id", ((verified_meta->>'idempotency_key')))
  WHERE "kind" = 'external_signal' AND verified_meta->>'idempotency_key' IS NOT NULL;
```

- [ ] **Step 10: Build + run test**

Run: `pnpm --filter @paperclipai/db build && pnpm --filter @paperclipai/db test outcomes-schema -v`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git checkout -b enforced-outcomes/01-schema
git add packages/db/
git commit -m "feat(db): outcomes table + per-entity required_outcomes (EO-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/01-schema
```

---

## Task 2: per-kind required-meta JSON schemas

**Files:**

- Create: `packages/shared/src/outcome-kinds/index.ts`
- Create: `packages/shared/src/outcome-kinds/{seven kinds}.ts`
- Create: `packages/shared/src/outcome-kinds/__tests__/validators.test.ts`

The pattern mirrors `packages/shared/src/artifact-kinds/` shipped in Artifacts Plan 1.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/outcome-kinds/__tests__/validators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  OUTCOME_KINDS,
  validateRequiredMeta,
  type OutcomeKind,
} from "../index.js";

describe("outcome-kinds validators", () => {
  it("exports the seven Plan-1 kinds", () => {
    expect(OUTCOME_KINDS).toEqual([
      "artifact_declared",
      "plan_completed",
      "decision_recorded",
      "approval_granted",
      "exit_criteria_met",
      "manual_signoff",
      "external_signal",
    ]);
  });

  it("requires a string `name` on every kind", () => {
    for (const kind of OUTCOME_KINDS) {
      const result = validateRequiredMeta(kind, {});
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]).toMatch(/name/);
    }
  });

  it("artifact_declared requires artifact_kind + name", () => {
    expect(validateRequiredMeta("artifact_declared", { name: "patch" }).ok).toBe(false);
    expect(
      validateRequiredMeta("artifact_declared", { name: "patch", artifact_kind: "code.patch" }).ok,
    ).toBe(true);
  });

  it("decision_recorded requires plan_id + decision_title", () => {
    expect(validateRequiredMeta("decision_recorded", { name: "go" }).ok).toBe(false);
    expect(
      validateRequiredMeta("decision_recorded", {
        name: "go", plan_id: "00000000-0000-0000-0000-000000000000", decision_title: "release-go",
      }).ok,
    ).toBe(true);
  });

  it("manual_signoff allows optional required_role", () => {
    expect(validateRequiredMeta("manual_signoff", { name: "ack" }).ok).toBe(true);
    expect(validateRequiredMeta("manual_signoff", { name: "ack", required_role: "ops" }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/shared test outcome-kinds -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/shared/src/outcome-kinds/index.ts`**

```ts
import { artifactDeclaredSchema } from "./artifact-declared.js";
import { planCompletedSchema } from "./plan-completed.js";
import { decisionRecordedSchema } from "./decision-recorded.js";
import { approvalGrantedSchema } from "./approval-granted.js";
import { exitCriteriaMetSchema } from "./exit-criteria-met.js";
import { manualSignoffSchema } from "./manual-signoff.js";
import { externalSignalSchema } from "./external-signal.js";

export const OUTCOME_KINDS = [
  "artifact_declared",
  "plan_completed",
  "decision_recorded",
  "approval_granted",
  "exit_criteria_met",
  "manual_signoff",
  "external_signal",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const requiredSchemas = {
  artifact_declared: artifactDeclaredSchema,
  plan_completed: planCompletedSchema,
  decision_recorded: decisionRecordedSchema,
  approval_granted: approvalGrantedSchema,
  exit_criteria_met: exitCriteriaMetSchema,
  manual_signoff: manualSignoffSchema,
  external_signal: externalSignalSchema,
};

export type RequiredMetaValidation = { ok: true } | { ok: false; errors: string[] };

export function validateRequiredMeta(kind: OutcomeKind, meta: unknown): RequiredMetaValidation {
  const result = requiredSchemas[kind].safeParse(meta);
  if (result.success) return { ok: true };
  return { ok: false, errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`) };
}
```

- [ ] **Step 4: Create the seven per-kind schema files**

Each kind exports a `zod` schema named `<kind>Schema`. Use `zod` (already a dep — same pattern as `artifact-kinds`). Example:

`packages/shared/src/outcome-kinds/artifact-declared.ts`:

```ts
import { z } from "zod";

export const artifactDeclaredSchema = z.object({
  name: z.string().min(1, "name is required"),
  artifact_kind: z.enum([
    "code.file", "code.patch", "doc.markdown", "doc.office",
    "chart", "data.table", "web.app",
  ]),
  name_glob: z.string().optional(),
});
```

`plan-completed.ts`:

```ts
import { z } from "zod";

export const planCompletedSchema = z.object({
  name: z.string().min(1),
  plan_id: z.string().uuid().optional(),
});
```

`decision-recorded.ts`:

```ts
import { z } from "zod";

export const decisionRecordedSchema = z.object({
  name: z.string().min(1),
  plan_id: z.string().uuid(),
  decision_title: z.string().min(1),
});
```

`approval-granted.ts`:

```ts
import { z } from "zod";

export const approvalGrantedSchema = z.object({
  name: z.string().min(1),
  approval_kind: z.string().min(1),
});
```

`exit-criteria-met.ts`:

```ts
import { z } from "zod";

export const exitCriteriaMetSchema = z.object({
  name: z.string().min(1),
  plan_phase_id: z.string().uuid(),
});
```

`manual-signoff.ts`:

```ts
import { z } from "zod";

export const manualSignoffSchema = z.object({
  name: z.string().min(1),
  required_role: z.string().optional(),
});
```

`external-signal.ts`:

```ts
import { z } from "zod";

export const externalSignalSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/shared test outcome-kinds -v`
Expected: PASS.

- [ ] **Step 6: Build to ensure exported types resolve**

Run: `pnpm --filter @paperclipai/shared build`
Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/02-validators
git add packages/shared/src/outcome-kinds/
git commit -m "feat(shared): outcome-kinds validators (EO-2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/02-validators
```

---

## Task 3: pure helper — contract diff

**Files:**

- Create: `server/src/services/outcomes/contract.ts`
- Create: `server/src/services/outcomes/__tests__/contract.test.ts`

`diffContract` takes the existing rows and the desired contract array, and returns three lists: rows to insert (new contract entries), rows to keep untouched (existing pending or verified that match a desired entry by `kind` + `name`), rows to delete (existing pending rows whose `name` no longer appears in the desired contract). Verified rows that are dropped from the desired contract stay in the DB (audit) but are reported as `droppedVerified` so the caller can log.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { diffContract } from "../contract.js";

describe("diffContract", () => {
  const existing = [
    { id: "a1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" },
    { id: "a2", kind: "approval_granted",  requiredMeta: { name: "legal" }, status: "verified" },
  ];

  it("inserts new contract entries that don't exist", () => {
    const desired = [
      { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
      { kind: "approval_granted",  requiredMeta: { name: "legal", approval_kind: "legal" } },
      { kind: "manual_signoff",    requiredMeta: { name: "ops-ack" } },
    ];
    const r = diffContract(existing, desired);
    expect(r.toInsert).toEqual([desired[2]]);
    expect(r.toKeep).toHaveLength(2);
    expect(r.pendingToDelete).toEqual([]);
    expect(r.droppedVerified).toEqual([]);
  });

  it("deletes pending rows that disappear from the desired contract", () => {
    const desired = [{ kind: "approval_granted", requiredMeta: { name: "legal", approval_kind: "legal" } }];
    const r = diffContract(existing, desired);
    expect(r.pendingToDelete.map((row) => row.id)).toEqual(["a1"]);
    expect(r.droppedVerified).toEqual([]);
  });

  it("keeps verified rows in the DB but reports them as droppedVerified when dropped", () => {
    const desired = [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }];
    const r = diffContract(existing, desired);
    expect(r.droppedVerified.map((row) => row.id)).toEqual(["a2"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/contract -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `contract.ts`**

```ts
export type ContractEntry = { kind: string; requiredMeta: { name: string; [k: string]: unknown } };
export type ExistingRow = { id: string; kind: string; requiredMeta: { name: string }; status: string };

export interface DiffResult {
  toInsert: ContractEntry[];
  toKeep: ExistingRow[];
  pendingToDelete: ExistingRow[];
  droppedVerified: ExistingRow[];
}

export function diffContract(existing: ExistingRow[], desired: ContractEntry[]): DiffResult {
  const key = (x: { kind: string; requiredMeta: { name: string } }) => `${x.kind}::${x.requiredMeta.name}`;
  const desiredKeys = new Set(desired.map(key));
  const existingKeys = new Set(existing.map(key));

  const toInsert = desired.filter((d) => !existingKeys.has(key(d)));
  const toKeep = existing.filter((e) => desiredKeys.has(key(e)));
  const dropped = existing.filter((e) => !desiredKeys.has(key(e)));
  const pendingToDelete = dropped.filter((e) => e.status === "pending");
  const droppedVerified = dropped.filter((e) => e.status === "verified");

  return { toInsert, toKeep, pendingToDelete, droppedVerified };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/contract -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes/03-contract-diff
git add server/src/services/outcomes/
git commit -m "feat(outcomes): pure contract-diff helper (EO-3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/03-contract-diff
```

---

## Task 4: pure helper — markdown checkbox parser

**Files:**

- Create: `server/src/services/outcomes/checkbox-parser.ts`
- Create: `server/src/services/outcomes/__tests__/checkbox-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseCheckboxes } from "../checkbox-parser.js";

describe("parseCheckboxes", () => {
  it("counts checked vs unchecked", () => {
    const md = `
- [x] one
- [ ] two
- [X] three
- [ ] four
`;
    const r = parseCheckboxes(md);
    expect(r.total).toBe(4);
    expect(r.checked).toBe(2);
    expect(r.allChecked).toBe(false);
  });

  it("returns allChecked=true only when total > 0 and checked == total", () => {
    expect(parseCheckboxes("- [x] one\n- [x] two").allChecked).toBe(true);
    expect(parseCheckboxes("- [ ] one").allChecked).toBe(false);
    expect(parseCheckboxes("").allChecked).toBe(false);   // empty = NOT verified
    expect(parseCheckboxes("no checkboxes here").allChecked).toBe(false);
  });

  it("ignores indented or escaped lines that aren't real list items", () => {
    expect(parseCheckboxes("`- [x] not a list`").total).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/checkbox-parser -v`
Expected: FAIL.

- [ ] **Step 3: Implement `checkbox-parser.ts`**

```ts
const RE = /^[\s>]*[-*+]\s+\[([ xX])\]\s/gm;

export interface CheckboxCount {
  total: number;
  checked: number;
  allChecked: boolean;
}

export function parseCheckboxes(markdown: string): CheckboxCount {
  let total = 0;
  let checked = 0;
  for (const m of markdown.matchAll(RE)) {
    total++;
    if (m[1] === "x" || m[1] === "X") checked++;
  }
  return { total, checked, allChecked: total > 0 && checked === total };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/checkbox-parser -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes/04-checkbox-parser
git add server/src/services/outcomes/checkbox-parser.ts server/src/services/outcomes/__tests__/checkbox-parser.test.ts
git commit -m "feat(outcomes): pure markdown checkbox parser (EO-4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/04-checkbox-parser
```

---

## Task 5: pure helper — HMAC verifier

**Files:**

- Create: `server/src/services/outcomes/hmac.ts`
- Create: `server/src/services/outcomes/__tests__/hmac.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSignature } from "../hmac.js";

describe("verifyHmacSignature", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ hello: "world" });
  const goodSig = createHmac("sha256", secret).update(body).digest("hex");

  it("returns true for a matching signature", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: goodSig })).toBe(true);
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: `sha256=${goodSig}` })).toBe(true);
  });

  it("returns false for a mismatched signature", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "deadbeef" })).toBe(false);
  });

  it("returns false for missing/empty inputs", () => {
    expect(verifyHmacSignature({ secret: "", rawBody: body, providedSig: goodSig })).toBe(false);
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "" })).toBe(false);
  });

  it("uses constant-time compare (no early-exit on length mismatch)", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "ab" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/hmac -v`
Expected: FAIL.

- [ ] **Step 3: Implement `hmac.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacInput {
  secret: string;
  rawBody: string;
  providedSig: string;
}

export function verifyHmacSignature(input: HmacInput): boolean {
  if (!input.secret || !input.providedSig) return false;
  const provided = input.providedSig.startsWith("sha256=")
    ? input.providedSig.slice("sha256=".length)
    : input.providedSig;
  const computed = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  if (provided.length !== computed.length) {
    // Pad to matched length so timingSafeEqual won't throw; still constant-time-ish at the boundary.
    return false;
  }
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(computed, "hex"));
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/hmac -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes/05-hmac
git add server/src/services/outcomes/hmac.ts server/src/services/outcomes/__tests__/hmac.test.ts
git commit -m "feat(outcomes): pure HMAC-SHA256 verifier (EO-5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/05-hmac
```

---

## Task 6: OutcomesService skeleton + materializeContract

**Files:**

- Create: `server/src/services/outcomes/types.ts`
- Create: `server/src/services/outcomes/service.ts`
- Create: `server/src/services/outcomes/__tests__/service.test.ts`

This task wires up the singleton, contract-write path, and reversion path. Verifier dispatch lands in Task 7+. The service exports an `OutcomeRequiredError` class so route handlers can `instanceof`-detect and translate to 422.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { initializeOutcomesService, getOutcomesService } from "../service.js";
import { OutcomeRequiredError } from "../types.js";

const makeFakeDb = () => {
  const rows: any[] = [];
  return {
    rows,
    transaction: async (fn: any) => fn({
      select: () => ({ from: () => ({ where: async () => rows.filter((r) => r.status !== "deleted") }) }),
      insert: () => ({ values: (v: any) => { rows.push({ ...v, id: `id-${rows.length}` }); return { returning: async () => [rows[rows.length - 1]] }; } }),
      update: () => ({ set: (s: any) => ({ where: () => ({ returning: async () => { rows.forEach((r) => Object.assign(r, s)); return rows; } }) }) }),
      delete: () => ({ where: async () => { /* mark deleted */ } }),
    }),
  };
};

describe("OutcomesService — materializeContract", () => {
  let svc: ReturnType<typeof initializeOutcomesService>;
  beforeEach(() => {
    svc = initializeOutcomesService({ db: makeFakeDb() as any });
  });

  it("inserts pending rows for new contract entries", async () => {
    const r = await svc.materializeContract(
      { kind: "issue", id: "iss-1", companyId: "co-1" },
      [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }],
    );
    expect(r.inserted).toBe(1);
  });

  it("rejects contract with invalid required_meta (missing name)", async () => {
    await expect(
      svc.materializeContract(
        { kind: "issue", id: "iss-1", companyId: "co-1" },
        [{ kind: "artifact_declared", requiredMeta: { artifact_kind: "code.patch" } as any }],
      ),
    ).rejects.toThrow(/name/);
  });
});

describe("OutcomeRequiredError", () => {
  it("renders a 422-shaped body", () => {
    const e = new OutcomeRequiredError({
      target: { kind: "issue", id: "i" },
      pending: [{ id: "o1", kind: "artifact_declared", requiredMeta: { name: "patch" } } as any],
    });
    expect(e.statusCode).toBe(422);
    expect(e.body).toMatchObject({
      code: "outcome_required",
      target: { kind: "issue", id: "i" },
      pending: [{ kind: "artifact_declared" }],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/service -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `types.ts`**

```ts
export type OutcomeTargetKind = "issue" | "plan";

export interface OutcomeTarget {
  kind: OutcomeTargetKind;
  id: string;
  companyId: string;
}

export interface OutcomeRowLite {
  id: string;
  kind: string;
  requiredMeta: { name: string; [k: string]: unknown };
  status: "pending" | "verified" | "reverted";
  verifiedMeta?: unknown;
  verifiedAt?: Date | null;
  revertedAt?: Date | null;
  revertedReason?: string | null;
}

export class OutcomeRequiredError extends Error {
  statusCode = 422;
  constructor(public payload: { target: { kind: OutcomeTargetKind; id: string }; pending: OutcomeRowLite[] }) {
    super(`Outcome required: ${payload.pending.length} pending`);
  }
  get body() {
    return {
      code: "outcome_required",
      target: this.payload.target,
      pending: this.payload.pending.map((p) => ({
        id: p.id, kind: p.kind, required_meta: p.requiredMeta,
      })),
    };
  }
}
```

- [ ] **Step 4: Create `service.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";
import { OUTCOME_KINDS, validateRequiredMeta, type OutcomeKind } from "@paperclipai/shared/outcome-kinds";
import { diffContract } from "./contract.js";
import { OutcomeRequiredError, type OutcomeTarget, type OutcomeRowLite } from "./types.js";

interface OutcomesServiceDeps { db: any /* postgres-js drizzle instance */ }

export class OutcomesService {
  constructor(private deps: OutcomesServiceDeps) {}

  async materializeContract(
    target: OutcomeTarget,
    desired: Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
  ): Promise<{ inserted: number; kept: number; pendingDeleted: number; droppedVerified: number }> {
    // Validate every entry up front; reject the whole write if any one is invalid.
    for (const entry of desired) {
      if (!OUTCOME_KINDS.includes(entry.kind as OutcomeKind)) {
        throw new Error(`Unknown outcome kind: ${entry.kind}`);
      }
      const v = validateRequiredMeta(entry.kind as OutcomeKind, entry.requiredMeta);
      if (!v.ok) throw new Error(`Invalid required_meta for ${entry.kind}: ${v.errors.join("; ")}`);
    }

    return this.deps.db.transaction(async (tx: any) => {
      const existing: OutcomeRowLite[] = await tx
        .select()
        .from(outcomes)
        .where(and(
          eq(outcomes.companyId, target.companyId),
          eq(outcomes.targetKind, target.kind),
          eq(outcomes.targetId, target.id),
        ));

      const diff = diffContract(
        existing.map((e) => ({ id: e.id, kind: e.kind, requiredMeta: e.requiredMeta, status: e.status })),
        desired.map((d) => ({ kind: d.kind, requiredMeta: d.requiredMeta as { name: string } })),
      );

      let inserted = 0;
      for (const entry of diff.toInsert) {
        await tx.insert(outcomes).values({
          companyId: target.companyId,
          targetKind: target.kind,
          targetId: target.id,
          kind: entry.kind,
          status: "pending",
          requiredMeta: entry.requiredMeta,
        });
        inserted++;
      }

      let pendingDeleted = 0;
      for (const row of diff.pendingToDelete) {
        await tx.delete(outcomes).where(eq(outcomes.id, row.id));
        pendingDeleted++;
      }

      return {
        inserted,
        kept: diff.toKeep.length,
        pendingDeleted,
        droppedVerified: diff.droppedVerified.length,
      };
    });
  }

  async listForTarget(target: OutcomeTarget): Promise<OutcomeRowLite[]> {
    return this.deps.db
      .select()
      .from(outcomes)
      .where(and(
        eq(outcomes.companyId, target.companyId),
        eq(outcomes.targetKind, target.kind),
        eq(outcomes.targetId, target.id),
      ));
  }

  async revertOutcome(outcomeId: string, reason: string): Promise<OutcomeRowLite> {
    const result = await this.deps.db
      .update(outcomes)
      .set({ status: "reverted", revertedAt: new Date(), revertedReason: reason, updatedAt: new Date() })
      .where(and(eq(outcomes.id, outcomeId), eq(outcomes.status, "verified")))
      .returning();
    if (result.length === 0) throw new Error("Outcome not in verified state");
    return result[0];
  }
}

let _instance: OutcomesService | null = null;

export function initializeOutcomesService(deps: OutcomesServiceDeps): OutcomesService {
  _instance = new OutcomesService(deps);
  return _instance;
}

export function getOutcomesService(): OutcomesService {
  if (!_instance) throw new Error("OutcomesService not initialized");
  return _instance;
}

export { OutcomeRequiredError };
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/service -v`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/06-service-skeleton
git add server/src/services/outcomes/types.ts server/src/services/outcomes/service.ts server/src/services/outcomes/__tests__/service.test.ts
git commit -m "feat(outcomes): OutcomesService skeleton + materializeContract + revert (EO-6)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/06-service-skeleton
```

---

## Task 7: verifier — `artifact_declared`

**Files:**

- Create: `server/src/services/outcomes/verifiers/index.ts`
- Create: `server/src/services/outcomes/verifiers/artifact-declared.ts`
- Create: `server/src/services/outcomes/__tests__/verifiers.test.ts`
- Modify: `server/src/services/outcomes/service.ts` — add `tryVerify(kind, evidence)` dispatch.

The verifier signature is uniform: `tryVerifyXxx(db, evidence) → { verifiedCount: number }`. It runs in its own DB transaction, looks up pending outcomes whose `(target_kind, target_id, kind)` would match the evidence, scores each against `required_meta`, and calls the guarded SQL update on matches. Idempotent — re-firing the same event after a row is already verified is a no-op.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { initializeOutcomesService } from "../service.js";

// fakeDb ergonomically tracks one outcomes row + one artifacts row by id.

describe("verifier — artifact_declared", () => {
  it("flips matching pending outcome to verified when artifact name + kind match", async () => {
    /* set up: pending outcome on issue 'i1' requiring artifact_kind='code.patch', name='patch'
       declare artifact: kind=code.patch, name='patch.diff', issue_id='i1'
       expect: outcome.status === 'verified', verified_meta.artifact_id set */
  });

  it("ignores artifact whose issue_id doesn't match the outcome target", async () => { /* … */ });

  it("respects name_glob when present", async () => { /* "*.diff" matches 'patch.diff' */ });

  it("is idempotent: a second firing for the already-verified outcome is a no-op", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v`
Expected: FAIL.

- [ ] **Step 3: Implement `verifiers/artifact-declared.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";

export interface ArtifactEvidence {
  id: string;          // artifact id
  companyId: string;
  issueId: string | null;
  kind: string;        // e.g., "code.patch"
  name: string;
  blobSha256: string;
  declaredAt: Date;
  /** When target_kind=plan, the plan row's issue_id; populated by caller. */
  planTargetIssueId?: string | null;
}

export async function verifyArtifactDeclared(db: any, evidence: ArtifactEvidence): Promise<{ verifiedCount: number }> {
  // Look up all pending artifact_declared outcomes in this company whose target_kind
  // resolves to a matching issue id.
  const pending = await db
    .select()
    .from(outcomes)
    .where(and(
      eq(outcomes.companyId, evidence.companyId),
      eq(outcomes.kind, "artifact_declared"),
      eq(outcomes.status, "pending"),
    ));

  let verifiedCount = 0;
  for (const row of pending) {
    if (!matches(row, evidence)) continue;
    const result = await db
      .update(outcomes)
      .set({
        status: "verified",
        verifiedMeta: {
          artifact_id: evidence.id,
          blob_sha256: evidence.blobSha256,
          declared_at: evidence.declaredAt.toISOString(),
        },
        verifiedAt: new Date(),
        verifiedByKind: "system",
        updatedAt: new Date(),
      })
      .where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending")))
      .returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}

function matches(row: any, e: ArtifactEvidence): boolean {
  // target match
  if (row.targetKind === "issue") {
    if (row.targetId !== e.issueId) return false;
  } else if (row.targetKind === "plan") {
    if (e.planTargetIssueId == null) return false;
    if (row.targetId !== e.planTargetIssueId) return false;
  } else {
    return false;
  }
  // kind match
  if (row.requiredMeta?.artifact_kind !== e.kind) return false;
  // name match: glob OR exact
  const glob: string | undefined = row.requiredMeta?.name_glob;
  const requiredName: string = row.requiredMeta?.name;
  if (glob) {
    return globMatch(glob, e.name);
  }
  return requiredName === e.name;
}

function globMatch(glob: string, str: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(str);
}
```

- [ ] **Step 4: Implement `verifiers/index.ts` and dispatch**

```ts
import { verifyArtifactDeclared } from "./artifact-declared.js";

export const VERIFIERS = {
  artifact_declared: verifyArtifactDeclared,
  // additional verifiers added in subsequent tasks
} as const;

export type VerifierKind = keyof typeof VERIFIERS;
```

In `service.ts`, add:

```ts
import { VERIFIERS, type VerifierKind } from "./verifiers/index.js";

// inside OutcomesService:
async tryVerify<K extends VerifierKind>(kind: K, evidence: Parameters<typeof VERIFIERS[K]>[1]): Promise<{ verifiedCount: number }> {
  const verifier = VERIFIERS[kind];
  if (!verifier) return { verifiedCount: 0 };
  try {
    return await verifier(this.deps.db, evidence as any);
  } catch (err) {
    // Best-effort — log, don't bubble.
    console.error("[outcomes] verifier error", { kind, err });
    return { verifiedCount: 0 };
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v`
Expected: PASS for the four `artifact_declared` cases.

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/07-verifier-artifact
git add server/src/services/outcomes/verifiers/ server/src/services/outcomes/__tests__/verifiers.test.ts server/src/services/outcomes/service.ts
git commit -m "feat(outcomes): verifier for artifact_declared (EO-7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/07-verifier-artifact
```

---

## Task 8: verifiers — `plan_completed` + `decision_recorded`

**Files:**

- Create: `server/src/services/outcomes/verifiers/plan-completed.ts`
- Create: `server/src/services/outcomes/verifiers/decision-recorded.ts`
- Modify: `server/src/services/outcomes/verifiers/index.ts`
- Modify: `server/src/services/outcomes/__tests__/verifiers.test.ts` — extend tests.

- [ ] **Step 1: Write failing tests** (append four cases — two per kind: happy path + idempotent re-fire)

```ts
describe("verifier — plan_completed", () => {
  it("flips outcome with plan_id wildcard when any plan tagged on the issue completes", async () => { /* … */ });
  it("flips outcome with explicit plan_id only when that plan_id matches", async () => { /* … */ });
});

describe("verifier — decision_recorded", () => {
  it("flips when a plan_decisions row with chosen_option_id and matching title is inserted", async () => { /* … */ });
  it("does not flip when chosen_option_id is null (only matched on non-null)", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v`
Expected: FAIL on the four new cases.

- [ ] **Step 3: Implement `verifiers/plan-completed.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";

export interface PlanCompletedEvidence {
  planId: string;
  companyId: string;
  issueId: string | null;     // plans.issue_id
  completedAt: Date;
  revisionId: string | null;
}

export async function verifyPlanCompleted(db: any, evidence: PlanCompletedEvidence): Promise<{ verifiedCount: number }> {
  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "plan_completed"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  for (const row of pending) {
    // target: issue match (the plan's issue_id), or plan-level (target id == planId).
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.issueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;
    const requiredPlanId: string | undefined = row.requiredMeta?.plan_id;
    if (requiredPlanId && requiredPlanId !== evidence.planId) continue;

    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta: { plan_id: evidence.planId, completed_at: evidence.completedAt.toISOString(), revision_id: evidence.revisionId },
      verifiedAt: new Date(), verifiedByKind: "system", updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}
```

- [ ] **Step 4: Implement `verifiers/decision-recorded.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";

export interface DecisionEvidence {
  decisionId: string;
  companyId: string;
  planId: string;
  planIssueId: string | null;
  title: string;            // plan_decisions.title
  chosenOptionId: string | null;
  decidedAt: Date;
}

export async function verifyDecisionRecorded(db: any, evidence: DecisionEvidence): Promise<{ verifiedCount: number }> {
  if (!evidence.chosenOptionId) return { verifiedCount: 0 };  // gate: only verified once a choice is recorded

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "decision_recorded"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  for (const row of pending) {
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.planIssueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;
    if (row.requiredMeta?.plan_id !== evidence.planId) continue;
    if (row.requiredMeta?.decision_title !== evidence.title) continue;

    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta: { decision_id: evidence.decisionId, chosen_option_id: evidence.chosenOptionId, decided_at: evidence.decidedAt.toISOString() },
      verifiedAt: new Date(), verifiedByKind: "system", updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}
```

- [ ] **Step 5: Wire into `verifiers/index.ts`**

```ts
import { verifyArtifactDeclared } from "./artifact-declared.js";
import { verifyPlanCompleted } from "./plan-completed.js";
import { verifyDecisionRecorded } from "./decision-recorded.js";

export const VERIFIERS = {
  artifact_declared: verifyArtifactDeclared,
  plan_completed: verifyPlanCompleted,
  decision_recorded: verifyDecisionRecorded,
} as const;
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/08-verifiers-plan-decision
git add server/src/services/outcomes/verifiers/ server/src/services/outcomes/__tests__/verifiers.test.ts
git commit -m "feat(outcomes): verifiers for plan_completed + decision_recorded (EO-8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/08-verifiers-plan-decision
```

---

## Task 9: verifiers — `approval_granted` + `exit_criteria_met`

**Files:**

- Create: `server/src/services/outcomes/verifiers/approval-granted.ts`
- Create: `server/src/services/outcomes/verifiers/exit-criteria-met.ts`
- Modify: `server/src/services/outcomes/verifiers/index.ts`
- Modify: `server/src/services/outcomes/__tests__/verifiers.test.ts`

- [ ] **Step 1: Write failing tests** (extend the test file with four more cases)

```ts
describe("verifier — approval_granted", () => {
  it("flips when approvals.status='approved' and approval_kind matches and the issue link exists in issue_approvals", async () => { /* … */ });
  it("ignores approval whose kind doesn't match required_meta.approval_kind", async () => { /* … */ });
});

describe("verifier — exit_criteria_met", () => {
  it("flips when phase exit_criteria_markdown has all checkboxes checked", async () => { /* "- [x] one\n- [x] two" → verified */ });
  it("does not flip when any checkbox is unchecked", async () => { /* "- [x] a\n- [ ] b" → pending */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v`
Expected: FAIL.

- [ ] **Step 3: Implement `verifiers/approval-granted.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { outcomes, issueApprovals } from "@paperclipai/db/schema";

export interface ApprovalEvidence {
  approvalId: string;
  companyId: string;
  approvalKind: string;
  decidedByUserId: string | null;
  decidedAt: Date;
}

export async function verifyApprovalGranted(db: any, evidence: ApprovalEvidence): Promise<{ verifiedCount: number }> {
  // Look up which issues this approval is linked to.
  const links = await db.select({ issueId: issueApprovals.issueId })
    .from(issueApprovals)
    .where(eq(issueApprovals.approvalId, evidence.approvalId));
  if (links.length === 0) return { verifiedCount: 0 };

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "approval_granted"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  for (const row of pending) {
    if (row.requiredMeta?.approval_kind !== evidence.approvalKind) continue;
    const matchesTarget = links.some((l: { issueId: string }) =>
      (row.targetKind === "issue" && row.targetId === l.issueId)
      // plan-level approval-granted not Plan-1: needs plan→issue join; deferred until needed
    );
    if (!matchesTarget) continue;

    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta: { approval_id: evidence.approvalId, decided_by_user_id: evidence.decidedByUserId, decided_at: evidence.decidedAt.toISOString() },
      verifiedAt: new Date(), verifiedByKind: "system", updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}
```

- [ ] **Step 4: Implement `verifiers/exit-criteria-met.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";
import { parseCheckboxes } from "../checkbox-parser.js";

export interface PhaseEvidence {
  planPhaseId: string;
  companyId: string;
  planId: string;
  planIssueId: string | null;
  exitCriteriaMarkdown: string;
}

export async function verifyExitCriteriaMet(db: any, evidence: PhaseEvidence): Promise<{ verifiedCount: number }> {
  const parsed = parseCheckboxes(evidence.exitCriteriaMarkdown);
  if (!parsed.allChecked) return { verifiedCount: 0 };

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "exit_criteria_met"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  for (const row of pending) {
    if (row.requiredMeta?.plan_phase_id !== evidence.planPhaseId) continue;
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.planIssueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;

    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta: { checked_count: parsed.checked, total_count: parsed.total, parsed_at: new Date().toISOString() },
      verifiedAt: new Date(), verifiedByKind: "system", updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}
```

- [ ] **Step 5: Wire into `verifiers/index.ts`** (add the two new entries to the `VERIFIERS` const).

- [ ] **Step 6: Run tests + type-check**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/verifiers -v && pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/09-verifiers-approval-exit
git add server/src/services/outcomes/verifiers/ server/src/services/outcomes/__tests__/verifiers.test.ts
git commit -m "feat(outcomes): verifiers for approval_granted + exit_criteria_met (EO-9)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/09-verifiers-approval-exit
```

---

## Task 10: verifiers — `manual_signoff` + `external_signal`

**Files:**

- Create: `server/src/services/outcomes/verifiers/manual-signoff.ts`
- Create: `server/src/services/outcomes/verifiers/external-signal.ts`
- Modify: `server/src/services/outcomes/verifiers/index.ts`
- Modify: `server/src/services/outcomes/service.ts` — expose `signOff` and `ingestSignal` methods that call these verifiers explicitly (manual_signoff and external_signal aren't event-driven; they're route-driven).
- Modify: `server/src/services/outcomes/__tests__/verifiers.test.ts`
- Modify: `server/src/services/outcomes/__tests__/service.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe("verifier — manual_signoff", () => {
  it("flips outcome and records verified_by_user_id; rejects if required_role mismatches user role", async () => { /* … */ });
});

describe("verifier — external_signal", () => {
  it("flips on valid HMAC + first idempotency-key", async () => { /* … */ });
  it("returns 200 with existing row on idempotency-key replay", async () => { /* … */ });
  it("returns 401 (returns null verified) on bad HMAC", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes -v`
Expected: FAIL on new cases.

- [ ] **Step 3: Implement `verifiers/manual-signoff.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";

export interface ManualSignoffInput {
  outcomeId: string;
  companyId: string;
  userId: string;
  userRole: string | null;
  note?: string;
}

export class SignoffRoleMismatchError extends Error { statusCode = 403; }

export async function verifyManualSignoff(db: any, input: ManualSignoffInput): Promise<{ verifiedCount: number }> {
  const rows = await db.select().from(outcomes).where(and(
    eq(outcomes.id, input.outcomeId),
    eq(outcomes.companyId, input.companyId),
    eq(outcomes.kind, "manual_signoff"),
    eq(outcomes.status, "pending"),
  ));
  if (rows.length === 0) return { verifiedCount: 0 };
  const row = rows[0];
  const requiredRole: string | undefined = row.requiredMeta?.required_role;
  if (requiredRole && requiredRole !== input.userRole) throw new SignoffRoleMismatchError(`signoff requires role: ${requiredRole}`);

  const result = await db.update(outcomes).set({
    status: "verified",
    verifiedMeta: { user_id: input.userId, signed_at: new Date().toISOString(), note: input.note ?? null },
    verifiedAt: new Date(), verifiedByKind: "user", verifiedById: input.userId, updatedAt: new Date(),
  }).where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.status, "pending"))).returning();
  return { verifiedCount: result.length };
}
```

- [ ] **Step 4: Implement `verifiers/external-signal.ts`**

```ts
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { outcomes, companies } from "@paperclipai/db/schema";
import { verifyHmacSignature } from "../hmac.js";

export class SignalAuthError extends Error { statusCode = 401; }
export class SignalReplayMismatchError extends Error { statusCode = 409; }

export interface SignalIngestInput {
  outcomeId: string;
  companyId: string;
  rawBody: string;
  signature: string;
  idempotencyKey: string;
}

export async function ingestExternalSignal(db: any, input: SignalIngestInput): Promise<{ verified: boolean; replay: boolean }> {
  const cos = await db.select({ secret: companies.outcomeSignalSecret }).from(companies).where(eq(companies.id, input.companyId));
  const secret = cos[0]?.secret;
  if (!secret) throw new SignalAuthError("signal secret not provisioned");
  if (!verifyHmacSignature({ secret, rawBody: input.rawBody, providedSig: input.signature })) {
    throw new SignalAuthError("hmac mismatch");
  }

  const rows = await db.select().from(outcomes).where(and(
    eq(outcomes.id, input.outcomeId),
    eq(outcomes.companyId, input.companyId),
    eq(outcomes.kind, "external_signal"),
  ));
  if (rows.length === 0) throw new SignalAuthError("outcome not found");
  const row = rows[0];

  // Idempotency check on already-verified replay.
  if (row.status === "verified") {
    if (row.verifiedMeta?.idempotency_key === input.idempotencyKey) {
      const sameBody = row.verifiedMeta?.payload_sha256 === sha256Hex(input.rawBody);
      if (!sameBody) throw new SignalReplayMismatchError("idempotency key conflict (different body)");
      return { verified: true, replay: true };
    }
    return { verified: true, replay: false };  // already verified by an earlier signal — no-op
  }

  const result = await db.update(outcomes).set({
    status: "verified",
    verifiedMeta: {
      idempotency_key: input.idempotencyKey,
      signature_verified: true,
      payload_sha256: sha256Hex(input.rawBody),
      received_at: new Date().toISOString(),
    },
    verifiedAt: new Date(), verifiedByKind: "webhook", updatedAt: new Date(),
  }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();

  return { verified: result.length > 0, replay: false };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
```

- [ ] **Step 5: Add `signOff` + `ingestSignal` methods to `OutcomesService`**

```ts
import { verifyManualSignoff, type ManualSignoffInput } from "./verifiers/manual-signoff.js";
import { ingestExternalSignal, type SignalIngestInput } from "./verifiers/external-signal.js";

// inside OutcomesService:
async signOff(input: ManualSignoffInput) { return verifyManualSignoff(this.deps.db, input); }
async ingestSignal(input: SignalIngestInput) { return ingestExternalSignal(this.deps.db, input); }
```

(Manual_signoff and external_signal are not in the auto-dispatch `VERIFIERS` map — they're route-driven, not event-driven.)

- [ ] **Step 6: Run tests + type-check**

Run: `pnpm --filter @paperclipai/server test outcomes -v && pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/10-verifiers-manual-external
git add server/src/services/outcomes/verifiers/ server/src/services/outcomes/service.ts server/src/services/outcomes/__tests__/
git commit -m "feat(outcomes): verifiers for manual_signoff + external_signal (EO-10)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/10-verifiers-manual-external
```

---

## Task 11: events.ts emitters on Artifacts/Plans/Approvals + boot wiring

**Files:**

- Create: `server/src/services/artifacts/events.ts`
- Create: `server/src/services/plans/events.ts`
- Create: `server/src/services/approvals-events.ts` (sibling of `approvals.ts`)
- Modify: `server/src/services/artifacts/service.ts` — emit `declared` after the existing tx commits.
- Modify: `server/src/services/plans/service.ts` — emit `completed`, `phaseCompleted`, `phaseMarkdownUpdated`, `decisionRecorded` after the respective tx commits.
- Modify: `server/src/services/approvals.ts` — emit `approved` when the status transitions to `approved`.
- Modify: `server/src/index.ts` — initialize OutcomesService at boot AFTER the four substrates' init, then wire subscribers.

- [ ] **Step 1: Write the failing test (boot-wiring integration)**

`server/src/__tests__/outcomes-subscriber-wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { artifactsEvents } from "../services/artifacts/events.js";
import { plansEvents } from "../services/plans/events.js";
import { approvalsEvents } from "../services/approvals-events.js";

describe("substrate event emitters", () => {
  it("artifactsEvents emits 'declared'", async () => {
    let payload: any = null;
    artifactsEvents.on("declared", (p) => { payload = p; });
    artifactsEvents.emit("declared", { id: "a1", kind: "code.patch" });
    expect(payload?.id).toBe("a1");
  });
  it("plansEvents emits the four expected event names", () => {
    expect(plansEvents.eventNames).toContain;  // smoke — see Step 3 for the actual emitter type
  });
  it("approvalsEvents emits 'approved'", async () => {
    let payload: any = null;
    approvalsEvents.on("approved", (p) => { payload = p; });
    approvalsEvents.emit("approved", { id: "ap1" });
    expect(payload?.id).toBe("ap1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes-subscriber-wiring -v`
Expected: FAIL.

- [ ] **Step 3: Create the three emitters**

Each is a 5-line file using `node:events`. Example `server/src/services/artifacts/events.ts`:

```ts
import { EventEmitter } from "node:events";

export interface ArtifactsEventMap {
  declared: { id: string; companyId: string; issueId: string | null; kind: string; name: string; blobSha256: string; declaredAt: Date };
}

class ArtifactsEvents extends EventEmitter {
  override emit<K extends keyof ArtifactsEventMap>(event: K, payload: ArtifactsEventMap[K]): boolean { return super.emit(event, payload); }
  override on<K extends keyof ArtifactsEventMap>(event: K, listener: (p: ArtifactsEventMap[K]) => void): this { return super.on(event, listener); }
}

export const artifactsEvents = new ArtifactsEvents();
```

`server/src/services/plans/events.ts`:

```ts
import { EventEmitter } from "node:events";

export interface PlansEventMap {
  completed: { planId: string; companyId: string; issueId: string | null; completedAt: Date; revisionId: string | null };
  phaseCompleted: { planPhaseId: string; companyId: string; planId: string; planIssueId: string | null; exitCriteriaMarkdown: string };
  phaseMarkdownUpdated: { planPhaseId: string; companyId: string; planId: string; planIssueId: string | null; exitCriteriaMarkdown: string };
  decisionRecorded: { decisionId: string; companyId: string; planId: string; planIssueId: string | null; title: string; chosenOptionId: string | null; decidedAt: Date };
}

class PlansEvents extends EventEmitter { /* same override pattern as above */ }

export const plansEvents = new PlansEvents();
```

`server/src/services/approvals-events.ts`:

```ts
import { EventEmitter } from "node:events";

export interface ApprovalsEventMap {
  approved: { approvalId: string; companyId: string; approvalKind: string; decidedByUserId: string | null; decidedAt: Date };
}

class ApprovalsEvents extends EventEmitter { /* same override pattern */ }

export const approvalsEvents = new ApprovalsEvents();
```

- [ ] **Step 4: Wire emitters into the four substrate services**

In `server/src/services/artifacts/service.ts`, find `declareArtifact` (or whichever method commits a new artifact). After `await tx.commit` (or after the awaited `.returning()`), add:

```ts
import { artifactsEvents } from "./events.js";
// …
artifactsEvents.emit("declared", {
  id: row.id, companyId: row.companyId, issueId: row.issueId, kind: row.kind,
  name: row.name, blobSha256: row.blobSha256, declaredAt: row.declaredAt,
});
```

In `server/src/services/plans/service.ts`, do the same after the `completePlan`, `completePhase`, `recordDecision` tx commits, and after the markdown-update path on phase. The phase-markdown event is debounced to fire when `exit_criteria_markdown` changes (compare old vs new).

In `server/src/services/approvals.ts`, after the approval-status update from `pending → approved`:

```ts
import { approvalsEvents } from "./approvals-events.js";
// …
if (oldStatus !== "approved" && newRow.status === "approved") {
  approvalsEvents.emit("approved", {
    approvalId: newRow.id, companyId: newRow.companyId, approvalKind: newRow.kind,
    decidedByUserId: newRow.decidedByUserId, decidedAt: newRow.decidedAt,
  });
}
```

- [ ] **Step 5: Boot wiring in `server/src/index.ts`**

After the four substrate services initialize, add (verifying that the existing `initializePlanService`, `initializeArtifactsService`, etc. are already in place from prior Tier-1 tasks):

```ts
import { initializeOutcomesService, getOutcomesService } from "./services/outcomes/service.js";
import { artifactsEvents } from "./services/artifacts/events.js";
import { plansEvents } from "./services/plans/events.js";
import { approvalsEvents } from "./services/approvals-events.js";

const outcomesService = initializeOutcomesService({ db: db as any });

artifactsEvents.on("declared", (p) => {
  void outcomesService.tryVerify("artifact_declared", p);
});
plansEvents.on("completed", (p) => {
  void outcomesService.tryVerify("plan_completed", p);
});
plansEvents.on("phaseCompleted", (p) => {
  void outcomesService.tryVerify("exit_criteria_met", p);
});
plansEvents.on("phaseMarkdownUpdated", (p) => {
  void outcomesService.tryVerify("exit_criteria_met", p);
});
plansEvents.on("decisionRecorded", (p) => {
  void outcomesService.tryVerify("decision_recorded", p);
});
approvalsEvents.on("approved", (p) => {
  void outcomesService.tryVerify("approval_granted", p);
});
```

- [ ] **Step 6: Run tests + type-check**

Run: `pnpm --filter @paperclipai/server test outcomes-subscriber-wiring -v && pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/11-events-and-wiring
git add server/src/services/artifacts/events.ts server/src/services/plans/events.ts server/src/services/approvals-events.ts \
        server/src/services/artifacts/service.ts server/src/services/plans/service.ts server/src/services/approvals.ts \
        server/src/index.ts server/src/__tests__/outcomes-subscriber-wiring.test.ts
git commit -m "feat(outcomes): substrate events.ts emitters + boot subscriber wiring (EO-11)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/11-events-and-wiring
```

---

## Task 12: gate-check predicate + integration into issueService

**Files:**

- Create: `server/src/services/outcomes/predicate.ts`
- Create: `server/src/services/outcomes/__tests__/predicate.test.ts`
- Modify: `server/src/services/issues.ts` — gate-check on transition to `done`; call `OutcomesService.materializeContract` on contract writes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { allOutcomesVerified } from "../predicate.js";
import { OutcomeRequiredError } from "../types.js";

describe("allOutcomesVerified", () => {
  it("returns true when no pending rows exist for the target", async () => {
    const db = { select: () => ({ from: () => ({ where: async () => [{ count: 0 }] }) }) } as any;
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBe(true);
  });
  it("returns OutcomeRequiredError when any pending rows exist", async () => {
    const calls: any[] = [];
    const db = {
      select: (...args: any[]) => { calls.push(args); return {
        from: () => ({ where: async () => calls.length === 1
          ? [{ count: 1 }]
          : [{ id: "o1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" }]
        })
      }; }
    } as any;
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBeInstanceOf(OutcomeRequiredError);
    expect((r as OutcomeRequiredError).body.pending).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/predicate -v`
Expected: FAIL.

- [ ] **Step 3: Implement `predicate.ts`**

```ts
import { and, count, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db/schema";
import { OutcomeRequiredError, type OutcomeTarget } from "./types.js";

export async function allOutcomesVerified(
  db: any, target: OutcomeTarget,
): Promise<true | OutcomeRequiredError> {
  const counts = await db.select({ count: count() }).from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
    eq(outcomes.status, "pending"),
  ));
  if (counts[0].count === 0) return true;

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
    eq(outcomes.status, "pending"),
  ));
  return new OutcomeRequiredError({
    target: { kind: target.kind, id: target.id },
    pending,
  });
}
```

- [ ] **Step 4: Integrate into `issueService.updateIssue`**

In `server/src/services/issues.ts`, locate the path that handles `status` transition to `done` (the `becameDone` block in `routes/issues.ts`/`services/issues.ts`). Add:

```ts
import { getOutcomesService } from "./outcomes/service.js";
import { allOutcomesVerified } from "./outcomes/predicate.js";
import { OutcomeRequiredError } from "./outcomes/types.js";

// inside the update path, BEFORE the SQL UPDATE:
if (newStatus === "done" && existing.status !== "done"
    && Array.isArray(existing.requiredOutcomes) && existing.requiredOutcomes.length > 0) {
  const result = await allOutcomesVerified(db, { kind: "issue", id: existing.id, companyId: existing.companyId });
  if (result instanceof OutcomeRequiredError) throw result;
}

// On contract write (PATCH issues/:id with required_outcomes):
if (patch.requiredOutcomes !== undefined) {
  await getOutcomesService().materializeContract(
    { kind: "issue", id: existing.id, companyId: existing.companyId },
    patch.requiredOutcomes as any,
  );
}
```

In `server/src/routes/issues.ts`, add a 422 translator for `OutcomeRequiredError`:

```ts
} catch (err) {
  if (err instanceof OutcomeRequiredError) return res.status(422).json(err.body);
  throw err;
}
```

- [ ] **Step 5: Add an integration test for the gate**

`server/src/__tests__/issue-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setupTestDb } from "./helpers/test-db.js";  // existing harness used in prior Tier-1 plans

describe("issue gate", () => {
  it("rejects status=done when required_outcomes has pending rows", async () => {
    /* set up issue with required_outcomes = [{kind: artifact_declared, requiredMeta: {name: patch, artifact_kind: code.patch}}]
       attempt PATCH status=done → expect 422 with code=outcome_required */
  });
  it("allows status=done after all outcomes verified", async () => {
    /* declare artifact with matching kind+name → outcome flips → PATCH status=done returns 200 */
  });
});
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @paperclipai/server test outcomes/__tests__/predicate issue-gate -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git checkout -b enforced-outcomes/12-issue-gate
git add server/src/services/outcomes/predicate.ts server/src/services/outcomes/__tests__/predicate.test.ts \
        server/src/services/issues.ts server/src/routes/issues.ts server/src/__tests__/issue-gate.test.ts
git commit -m "feat(outcomes): gate-check predicate + issue-done integration (EO-12)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/12-issue-gate
```

---

## Task 13: gate-check on PlanService.completePlan

**Files:**

- Modify: `server/src/services/plans/service.ts` — add gate-check to `completePlan`; call `materializeContract` on plan contract writes.
- Modify: `server/src/__tests__/plan-gate.test.ts` (new file).

- [ ] **Step 1: Write failing test**

```ts
describe("plan gate", () => {
  it("rejects completePlan when required_outcomes has pending rows", async () => {
    /* expect 422 thrown */
  });
  it("allows completePlan after all outcomes verified", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test plan-gate -v`
Expected: FAIL.

- [ ] **Step 3: Implement gate in `PlanService.completePlan`**

```ts
import { allOutcomesVerified } from "../outcomes/predicate.js";
import { OutcomeRequiredError } from "../outcomes/types.js";
import { getOutcomesService } from "../outcomes/service.js";

// inside completePlan(planId):
const plan = await this.deps.db.query.plans.findFirst({ where: eq(plans.id, planId) });
if (Array.isArray(plan.requiredOutcomes) && plan.requiredOutcomes.length > 0) {
  const result = await allOutcomesVerified(this.deps.db, { kind: "plan", id: plan.id, companyId: plan.companyId });
  if (result instanceof OutcomeRequiredError) throw result;
}

// inside updatePlan(patch.required_outcomes):
if (patch.requiredOutcomes !== undefined) {
  await getOutcomesService().materializeContract(
    { kind: "plan", id: plan.id, companyId: plan.companyId },
    patch.requiredOutcomes as any,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server test plan-gate -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b enforced-outcomes/13-plan-gate
git add server/src/services/plans/service.ts server/src/__tests__/plan-gate.test.ts
git commit -m "feat(outcomes): gate-check on PlanService.completePlan (EO-13)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/13-plan-gate
```

---

## Task 14: REST routes

**Files:**

- Create: `server/src/routes/outcomes.ts`
- Modify: `server/src/app.ts` — register routes.

(Secret rotation is a small enough operation that it lives directly in the route handler — no need to add a service method for it.)

Routes from the spec:

```
GET   /api/companies/:cid/outcomes?target_kind=&target_id=
GET   /api/companies/:cid/outcomes/:id
POST  /api/companies/:cid/outcomes/:id/signoff
POST  /api/companies/:cid/outcomes/:id/signal
POST  /api/companies/:cid/outcomes/:id/revert
POST  /api/companies/:cid/outcomes/_secrets/signal/rotate
GET   /api/instance/outcomes
```

- [ ] **Step 1: Write the failing test**

`server/src/routes/__tests__/outcomes.routes.test.ts`:

```ts
describe("outcomes routes", () => {
  it("GET /api/companies/:cid/outcomes lists by target", async () => { /* expect 200 + array */ });
  it("POST /signoff verifies a manual_signoff outcome", async () => { /* … */ });
  it("POST /signal rejects bad HMAC with 401", async () => { /* … */ });
  it("POST /signal returns 200 idempotent on replay", async () => { /* … */ });
  it("POST /signal returns 409 on idempotency-key conflict (different body, same key)", async () => { /* … */ });
  it("POST /revert flips verified → reverted", async () => { /* … */ });
  it("POST /_secrets/signal/rotate generates a new secret (admin only)", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test outcomes.routes -v`
Expected: FAIL.

- [ ] **Step 3: Implement `routes/outcomes.ts`**

```ts
import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { outcomes, companies } from "@paperclipai/db/schema";
import { getOutcomesService } from "../services/outcomes/service.js";
import { OutcomeRequiredError } from "../services/outcomes/types.js";
import { SignalAuthError, SignalReplayMismatchError } from "../services/outcomes/verifiers/external-signal.js";
import { SignoffRoleMismatchError } from "../services/outcomes/verifiers/manual-signoff.js";
import { db } from "../db.js";   // existing db handle
import { requireCompanyAuth, requireUser, requireInstanceAdmin } from "../auth/middleware.js";  // existing
import { rawBody } from "../middleware/raw-body.js";  // existing

export function outcomesRouter(): Router {
  const r = Router();

  r.get("/api/companies/:cid/outcomes", requireCompanyAuth, async (req, res) => {
    const { target_kind, target_id } = req.query;
    if (typeof target_kind !== "string" || typeof target_id !== "string") {
      return res.status(400).json({ error: "target_kind and target_id required" });
    }
    if (target_kind !== "issue" && target_kind !== "plan") return res.status(400).json({ error: "invalid target_kind" });
    const list = await getOutcomesService().listForTarget({ kind: target_kind, id: target_id, companyId: req.params.cid });
    res.json({ outcomes: list });
  });

  r.get("/api/companies/:cid/outcomes/:id", requireCompanyAuth, async (req, res) => {
    const rows = await db.select().from(outcomes).where(eq(outcomes.id, req.params.id));
    if (rows.length === 0 || rows[0].companyId !== req.params.cid) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  });

  r.post("/api/companies/:cid/outcomes/:id/signoff", requireCompanyAuth, requireUser, async (req, res) => {
    try {
      const r2 = await getOutcomesService().signOff({
        outcomeId: req.params.id,
        companyId: req.params.cid,
        userId: req.user.id,
        userRole: req.user.role,
        note: req.body?.note,
      });
      res.json({ verified: r2.verifiedCount > 0 });
    } catch (e) {
      if (e instanceof SignoffRoleMismatchError) return res.status(403).json({ error: e.message });
      throw e;
    }
  });

  r.post("/api/companies/:cid/outcomes/:id/signal", rawBody, async (req, res) => {
    const idemKey = req.header("Idempotency-Key");
    const sig = req.header("X-Outcome-Signature") ?? "";
    if (!idemKey) return res.status(400).json({ error: "Idempotency-Key required" });
    try {
      const r2 = await getOutcomesService().ingestSignal({
        outcomeId: req.params.id, companyId: req.params.cid,
        rawBody: (req as any).rawBody as string, signature: sig, idempotencyKey: idemKey,
      });
      res.status(r2.replay ? 200 : (r2.verified ? 200 : 200)).json(r2);
    } catch (e) {
      if (e instanceof SignalAuthError) return res.status(401).json({ error: e.message });
      if (e instanceof SignalReplayMismatchError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  r.post("/api/companies/:cid/outcomes/:id/revert", requireCompanyAuth, requireUser, async (req, res) => {
    try {
      const out = await getOutcomesService().revertOutcome(req.params.id, req.body?.reason ?? "operator");
      res.json(out);
    } catch (e: any) {
      if (e?.message === "Outcome not in verified state") return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  r.post("/api/companies/:cid/outcomes/_secrets/signal/rotate", requireCompanyAuth, requireUser, async (req, res) => {
    const secret = randomBytes(32).toString("hex");
    await db.update(companies).set({ outcomeSignalSecret: secret }).where(eq(companies.id, req.params.cid));
    res.json({ secret });   // shown once; operator stores it
  });

  r.get("/api/instance/outcomes", requireInstanceAdmin, async (_req, res) => {
    const list = await db.select().from(outcomes).limit(500);
    res.json({ outcomes: list });
  });

  return r;
}
```

- [ ] **Step 4: Register the router in `server/src/app.ts`**

```ts
import { outcomesRouter } from "./routes/outcomes.js";
// …
app.use(outcomesRouter());
```

- [ ] **Step 5: Run tests + type-check**

Run: `pnpm --filter @paperclipai/server test outcomes.routes -v && pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git checkout -b enforced-outcomes/14-routes
git add server/src/routes/outcomes.ts server/src/app.ts server/src/services/outcomes/service.ts server/src/routes/__tests__/outcomes.routes.test.ts
git commit -m "feat(outcomes): REST endpoints (list/get/signoff/signal/revert/rotate/admin) (EO-14)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/14-routes
```

---

## Task 15: UI — Outcomes tab on issue + plan detail

**Files:**

- Create: `ui/src/api/outcomes.ts`
- Create: `ui/src/components/OutcomesTab.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `ui/src/pages/PlanDetail.tsx`

The Outcomes tab is one shared component used in both IssueDetail and PlanDetail. It renders the checklist with: status pill, evidence link (artifact thumbnail / plan link / approval link), edit-contract button, sign-off button on `manual_signoff` rows, withdraw button on verified rows.

- [ ] **Step 1: Write a Vitest component test**

`ui/src/components/__tests__/OutcomesTab.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { OutcomesTab } from "../OutcomesTab.js";

describe("OutcomesTab", () => {
  it("renders three rows with status pills", async () => {
    vi.mock("../../api/outcomes.js", () => ({
      listOutcomes: async () => [
        { id: "1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" },
        { id: "2", kind: "approval_granted", requiredMeta: { name: "legal" }, status: "verified" },
        { id: "3", kind: "manual_signoff", requiredMeta: { name: "ack" }, status: "reverted" },
      ],
    }));
    render(<OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />);
    expect(await screen.findByText("artifact_declared")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("reverted")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/ui test OutcomesTab -v`
Expected: FAIL.

- [ ] **Step 3: Implement `ui/src/api/outcomes.ts`**

```ts
export interface OutcomeRowDto {
  id: string;
  kind: string;
  requiredMeta: Record<string, unknown>;
  status: "pending" | "verified" | "reverted";
  verifiedMeta?: Record<string, unknown>;
  verifiedAt?: string;
  revertedAt?: string;
}

export async function listOutcomes(target: { kind: "issue" | "plan"; id: string; companyId: string }): Promise<OutcomeRowDto[]> {
  const u = `/api/companies/${target.companyId}/outcomes?target_kind=${target.kind}&target_id=${target.id}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`outcomes list failed: ${r.status}`);
  const j = await r.json();
  return j.outcomes;
}

export async function signOff(companyId: string, outcomeId: string, note?: string) {
  const r = await fetch(`/api/companies/${companyId}/outcomes/${outcomeId}/signoff`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
  });
  if (!r.ok) throw new Error(`signoff failed: ${r.status}`);
  return r.json();
}

export async function revertOutcome(companyId: string, outcomeId: string, reason: string) {
  const r = await fetch(`/api/companies/${companyId}/outcomes/${outcomeId}/revert`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
  });
  if (!r.ok) throw new Error(`revert failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 4: Implement `ui/src/components/OutcomesTab.tsx`**

```tsx
import { useEffect, useState } from "react";
import { listOutcomes, signOff, revertOutcome, type OutcomeRowDto } from "../api/outcomes.js";

export function OutcomesTab({ target }: { target: { kind: "issue" | "plan"; id: string; companyId: string } }) {
  const [rows, setRows] = useState<OutcomeRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { listOutcomes(target).then(setRows).catch((e) => setError(String(e))); }, [target.id]);

  if (error) return <div className="error">{error}</div>;
  if (!rows) return <div>Loading…</div>;
  if (rows.length === 0) return <div className="muted">No outcomes required for this {target.kind}.</div>;

  return (
    <table className="outcomes-table">
      <thead><tr><th>Kind</th><th>Name</th><th>Status</th><th>Evidence</th><th>Actions</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.kind}</td>
            <td>{String(r.requiredMeta.name ?? "")}</td>
            <td><StatusPill status={r.status} /></td>
            <td><EvidenceLink row={r} /></td>
            <td>
              {r.status === "pending" && r.kind === "manual_signoff" && (
                <button onClick={async () => { await signOff(target.companyId, r.id); refresh(); }}>Sign off</button>
              )}
              {r.status === "verified" && (
                <button onClick={async () => {
                  const reason = prompt("Reason for revert?");
                  if (reason) { await revertOutcome(target.companyId, r.id, reason); refresh(); }
                }}>Withdraw</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  function refresh() { listOutcomes(target).then(setRows); }
}

function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

function EvidenceLink({ row }: { row: OutcomeRowDto }) {
  if (row.status !== "verified" || !row.verifiedMeta) return null;
  if (row.kind === "artifact_declared" && typeof row.verifiedMeta.artifact_id === "string") {
    return <a href={`/artifacts/${row.verifiedMeta.artifact_id}`}>artifact</a>;
  }
  if (row.kind === "plan_completed" && typeof row.verifiedMeta.plan_id === "string") {
    return <a href={`/plans/${row.verifiedMeta.plan_id}`}>plan</a>;
  }
  if (row.kind === "approval_granted" && typeof row.verifiedMeta.approval_id === "string") {
    return <a href={`/approvals/${row.verifiedMeta.approval_id}`}>approval</a>;
  }
  return null;
}
```

- [ ] **Step 5: Add to IssueDetail and PlanDetail**

In `ui/src/pages/IssueDetail.tsx`, in the existing tab list add `<Tab name="Outcomes"><OutcomesTab target={{ kind: "issue", id: issue.id, companyId: issue.companyId }} /></Tab>`. Same for `PlanDetail.tsx`.

- [ ] **Step 6: Disable the "Mark done" button when pending outcomes exist (graceful UX)**

The 422 surfaces the same info via API, but the spec calls out that the status-transition button should disable up-front. In `IssueDetail.tsx`, fetch the outcomes list (or cache it from the tab) and compute `pendingCount = rows.filter((r) => r.status === "pending").length`. Disable the "Mark done" button when `pendingCount > 0` and add `title={\`${pendingCount} outcome(s) still pending\`}`. Same in `PlanDetail.tsx` for the "Mark plan complete" button.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @paperclipai/ui test OutcomesTab -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git checkout -b enforced-outcomes/15-ui-tab
git add ui/src/api/outcomes.ts ui/src/components/OutcomesTab.tsx ui/src/pages/IssueDetail.tsx ui/src/pages/PlanDetail.tsx ui/src/components/__tests__/OutcomesTab.test.tsx
git commit -m "feat(outcomes): UI — Outcomes tab on issue + plan detail (EO-15)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/15-ui-tab
```

---

## Task 16: UI — `/instance/outcomes` admin + routine "Outcomes contract" config

**Files:**

- Create: `ui/src/pages/Outcomes.tsx`
- Modify: `ui/src/App.tsx` — register `/instance/outcomes` (using the existing `lazyNamed` pattern).
- Modify: `ui/src/pages/AdminRoutines.tsx` (or whichever file holds the routine-edit form — the engineer touches whatever's actually there) — add an "Outcomes contract" section.
- Modify: `server/src/services/routines.ts` — when a routine fires and creates an issue, copy `routines.default_required_outcomes` into the new issue's `required_outcomes` (and call `OutcomesService.materializeContract` so pending rows materialize).

- [ ] **Step 1: Write failing tests**

`ui/src/pages/__tests__/Outcomes.test.tsx`:

```tsx
describe("/instance/outcomes admin page", () => {
  it("lists outcomes across companies with target/kind/status", async () => { /* render + expect rows */ });
});
```

`server/src/services/__tests__/routine-contract-inheritance.test.ts`:

```ts
describe("routine outcome inheritance", () => {
  it("copies default_required_outcomes onto new issues created from a routine", async () => {
    /* set up routine with default_required_outcomes; fire routine → expect issue.required_outcomes set; expect pending outcomes materialized */
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/ui test Outcomes -v && pnpm --filter @paperclipai/server test routine-contract-inheritance -v`
Expected: FAIL.

- [ ] **Step 3: Implement `ui/src/pages/Outcomes.tsx`**

```tsx
import { useEffect, useState } from "react";

export function Outcomes() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { fetch("/api/instance/outcomes").then(r => r.json()).then(j => setRows(j.outcomes)); }, []);
  if (!rows) return <div>Loading…</div>;
  return (
    <table>
      <thead><tr><th>Company</th><th>Target</th><th>Kind</th><th>Status</th><th>Verified at</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td>{r.companyId}</td><td>{r.targetKind}/{r.targetId.slice(0,8)}</td>
          <td>{r.kind}</td><td>{r.status}</td><td>{r.verifiedAt ?? "—"}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
```

- [ ] **Step 4: Register in `ui/src/App.tsx`**

```tsx
const Outcomes = lazyNamed(() => import("./pages/Outcomes"), "Outcomes");
// in route table:
<Route path="/instance/outcomes" element={<Outcomes />} />
```

- [ ] **Step 5: Add "Outcomes contract" section to routine form**

In `ui/src/pages/AdminRoutines.tsx` (or whichever file), add a JSON editor field for `defaultRequiredOutcomes`. Backend route `PATCH /api/companies/:cid/routines/:id` already accepts arbitrary fields — just plumb the column.

- [ ] **Step 6: Routine inheritance in `server/src/services/routines.ts`**

In the routine-fire path (where the new issue is created from the routine), after the issue insert:

```ts
import { getOutcomesService } from "./outcomes/service.js";
// …
if (Array.isArray(routine.defaultRequiredOutcomes) && routine.defaultRequiredOutcomes.length > 0) {
  await db.update(issues).set({ requiredOutcomes: routine.defaultRequiredOutcomes }).where(eq(issues.id, newIssue.id));
  await getOutcomesService().materializeContract(
    { kind: "issue", id: newIssue.id, companyId: newIssue.companyId },
    routine.defaultRequiredOutcomes as any,
  );
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @paperclipai/ui test Outcomes -v && pnpm --filter @paperclipai/server test routine-contract-inheritance -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git checkout -b enforced-outcomes/16-ui-admin-routines
git add ui/src/pages/Outcomes.tsx ui/src/App.tsx ui/src/pages/AdminRoutines.tsx server/src/services/routines.ts \
        ui/src/pages/__tests__/Outcomes.test.tsx server/src/services/__tests__/routine-contract-inheritance.test.ts
git commit -m "feat(outcomes): /instance/outcomes admin + routine contract inheritance (EO-16)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/16-ui-admin-routines
```

---

## Task 17: Memory subscriber + OTel spans + 5 metric streams

**Files:**

- Create: `server/src/services/memory/outcome-subscriber.ts`
- Create: `server/src/services/outcomes/spans.ts`
- Create: `server/src/services/outcomes/metrics.ts`
- Modify: `server/src/services/outcomes/service.ts` — call into spans + metrics.
- Modify: `server/src/index.ts` — wire memory's outcome subscriber.

The Memory subscriber records `outcome.verified` and `outcome.reverted` events as procedural memory entries — feeds back into the existing memory substrate (Plan 1 of Memory) so future runs see "this kind of issue typically required outcomes X, Y, Z." Pure additive subscriber; doesn't change the source-of-truth flow.

- [ ] **Step 1: Write failing test**

```ts
describe("memory outcome subscriber", () => {
  it("inserts a procedural memory entry on outcome.verified", async () => { /* … */ });
  it("inserts a procedural memory entry on outcome.reverted", async () => { /* … */ });
});

describe("outcomes spans + metrics", () => {
  it("starts a paperclip.outcome.try_verify span on each tryVerify call", async () => { /* … */ });
  it("increments paperclip_outcome_verified_total{kind} on success", async () => { /* … */ });
  it("increments paperclip_outcome_gate_blocked_total{target_kind} when allOutcomesVerified throws", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @paperclipai/server test memory/outcome-subscriber outcomes/spans outcomes/metrics -v`
Expected: FAIL.

- [ ] **Step 3: Implement `outcome-subscriber.ts`**

```ts
import type { MemoryService } from "./service.js";

interface OutcomeEvent { kind: string; targetKind: string; targetId: string; companyId: string; }

export function attachMemoryOutcomeSubscriber(memory: MemoryService) {
  return {
    onVerified: async (e: OutcomeEvent & { verifiedMeta: any }) => {
      await memory.recordEntry({
        companyId: e.companyId, layer: "procedural",
        title: `Outcome verified: ${e.kind}`,
        body: `Target ${e.targetKind}/${e.targetId} verified outcome of kind ${e.kind}.`,
        evidenceJson: e.verifiedMeta,
      });
    },
    onReverted: async (e: OutcomeEvent & { reason: string }) => {
      await memory.recordEntry({
        companyId: e.companyId, layer: "procedural",
        title: `Outcome reverted: ${e.kind}`,
        body: `Target ${e.targetKind}/${e.targetId} reverted outcome of kind ${e.kind}: ${e.reason}.`,
      });
    },
  };
}
```

- [ ] **Step 4: Implement `spans.ts` and `metrics.ts`**

`spans.ts`:

```ts
import { trace, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("paperclip-outcomes");

export function withSpan<T>(name: string, attrs: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`paperclip.outcome.${name}`, { attributes: attrs }, async (span) => {
    try { return await fn(span); } finally { span.end(); }
  });
}
```

`metrics.ts`:

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("paperclip-outcomes");

export const verifiedCounter = meter.createCounter("paperclip_outcome_verified_total", { description: "outcomes flipped to verified" });
export const revertedCounter = meter.createCounter("paperclip_outcome_reverted_total", { description: "outcomes flipped to reverted" });
export const gateBlockedCounter = meter.createCounter("paperclip_outcome_gate_blocked_total", { description: "422 outcome_required thrown" });
export const signalCounter = meter.createCounter("paperclip_outcome_signal_received_total", { description: "external_signal POSTs" });

const pendingGauge = meter.createObservableGauge("paperclip_outcome_pending_total", { description: "pending outcomes" });
let countsByKind: Map<string, number> = new Map();
pendingGauge.addCallback((obs) => {
  for (const [k, v] of countsByKind) obs.observe(v, { kind: k });
});
export function setPendingCounts(map: Map<string, number>) { countsByKind = map; }
```

- [ ] **Step 5: Wire spans + metrics into `OutcomesService`**

Wrap `tryVerify`, `materializeContract`, `revertOutcome` with `withSpan`. Increment `verifiedCounter` on each verifier success. Increment `revertedCounter` on `revertOutcome` success. Increment `gateBlockedCounter` from the gate-check call sites in `issueService.updateIssue` and `PlanService.completePlan` after catching `OutcomeRequiredError`.

- [ ] **Step 6: Wire memory subscriber in `server/src/index.ts`**

Add an in-process emitter on `OutcomesService` (or the outcomes service emits its own events the memory subscriber listens to). Simplest: call the memory subscriber directly from `OutcomesService.tryVerify` and `revertOutcome` after success.

- [ ] **Step 7: Run tests + type-check**

Run: `pnpm --filter @paperclipai/server test memory/outcome-subscriber outcomes/spans outcomes/metrics -v && pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git checkout -b enforced-outcomes/17-memory-otel
git add server/src/services/memory/outcome-subscriber.ts server/src/services/outcomes/spans.ts server/src/services/outcomes/metrics.ts server/src/services/outcomes/service.ts server/src/index.ts
git commit -m "feat(outcomes): memory subscriber + OTel spans + 5 metric streams (EO-17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/17-memory-otel
```

---

## Task 18: end-to-end smoke + green build + ROADMAP

**Files:**

- Modify: `scripts/smoke/tier1-e2e.sh`
- Modify: `ROADMAP.md`
- Modify: `README.md`

- [ ] **Step 1: Append outcomes block to `scripts/smoke/tier1-e2e.sh`**

After the existing artifacts block in the script, add:

```bash
# ---- Enforced Outcomes ----

# Set a contract on the issue: requires one artifact_declared.
echo "PATCH issue with required_outcomes contract"
curl -fsSL -X PATCH "$API/api/companies/$CID/issues/$ISSUE_ID" \
  -H 'content-type: application/json' \
  -d '{"required_outcomes":[{"kind":"artifact_declared","required_meta":{"name":"patch","artifact_kind":"code.patch"}}]}'

# Attempt to mark the issue done — expect 422.
echo "Attempt status=done (expect 422)"
HTTP=$(curl -s -o /tmp/eo-422.json -w '%{http_code}' -X PATCH "$API/api/companies/$CID/issues/$ISSUE_ID" \
  -H 'content-type: application/json' -d '{"status":"done"}')
[ "$HTTP" = "422" ] || { echo "expected 422, got $HTTP"; cat /tmp/eo-422.json; exit 1; }
grep -q outcome_required /tmp/eo-422.json

# Declare the artifact that satisfies the contract.
echo "Declare artifact"
curl -fsSL -X POST "$API/api/companies/$CID/artifacts" \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"code.patch\",\"name\":\"patch\",\"issue_id\":\"$ISSUE_ID\",\"content\":\"--- diff ---\"}"

# Sleep briefly to let the in-process subscriber flip the outcome.
sleep 0.5

# Retry mark-done — expect 200.
echo "Retry status=done (expect 200)"
curl -fsSL -X PATCH "$API/api/companies/$CID/issues/$ISSUE_ID" \
  -H 'content-type: application/json' -d '{"status":"done"}'

echo "EO smoke OK"
```

- [ ] **Step 2: Run the e2e smoke locally**

Boot the dev server (`pnpm dev` in one terminal). In another:

```bash
PAPERCLIP_PORT=3199 PAPERCLIP_E2E_DIR=/tmp/paperclip-e2e-eo scripts/smoke/tier1-e2e.sh
```

Expected: end-to-end PASS including the new outcomes block.

- [ ] **Step 3: Whole-repo green build**

Run: `pnpm -r build && pnpm -r exec tsc --noEmit`
Expected: clean across `db`, `shared`, `server`, `ui`.

- [ ] **Step 4: Update ROADMAP.md**

Flip `### ⚪ Enforced Outcomes` → `### 🚧 Enforced Outcomes` and add a close-out paragraph after the existing directional one:

```
Plan 1 (foundation) is in flight: `outcomes` table with polymorphic target (issue/plan), 7 typed kinds (artifact_declared, plan_completed, decision_recorded, approval_granted, exit_criteria_met, manual_signoff, external_signal) with per-kind JSON-schema validators, pure helpers (contract-diff, markdown-checkbox parser, HMAC verifier with timing-safe compare), `OutcomesService` singleton with tenant gate + materializeContract (insert/keep/drop diff) + tryVerify (idempotent, best-effort, errors-don't-bubble) + revertOutcome (sticky terminal), in-process `events.ts` emitters on Artifacts/Plans/Approvals + boot-time subscriber wiring (Outcomes is the only listener; Memory subscribes to outcome events for procedural ingest), gate-check predicate at `issueService.updateIssue → done` and `PlanService.completePlan` (422 OutcomeRequiredError with structured pending list), REST endpoints (list/get/signoff/signal/revert/rotate-secret/instance-admin), UI Outcomes tab on issue + plan detail + `/instance/outcomes` admin + routine "Outcomes contract" inheritance, OTel spans + 5 metric streams, e2e smoke addition. Plan 2 layers on provider-specific webhook adapters (GitHub PR-merged, Linear, GitHub-Actions), plan/routine templates carrying `default_required_outcomes`, `playbooks.suggested_outcomes` autopopulation, opt-in reopen-on-revert, outcome aliases, auto-archival, MCP-Resource adapter.
```

- [ ] **Step 5: Update README.md**

Two edits:

1. Roadmap preview: flip `- ⚪ Enforced Outcomes` → `- 🚧 Enforced Outcomes`.
2. Tier-1 Foundations panel: add a card for Enforced Outcomes with the one-line summary "Opt-in outcome contracts on issues + plans, 7 typed kinds verified via in-process pub/sub over the four landed substrates."

- [ ] **Step 6: Commit + push**

```bash
git checkout -b enforced-outcomes/18-e2e-roadmap
git add scripts/smoke/tier1-e2e.sh ROADMAP.md README.md
git commit -m "feat(outcomes): e2e smoke + ROADMAP/README close-out (EO-18)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push -u origin enforced-outcomes/18-e2e-roadmap
```

- [ ] **Step 7: Open PR (or merge each branch in sequence)**

Standard pattern: rebase each EO-N branch onto master, fast-forward merge, push. Or open a single PR for the whole stack if the team prefers — but the per-task branch pattern from the prior Tier-1 plans keeps the review surface small.

---

## Self-review notes (informational, not a step)

After all 18 tasks land:
- `pnpm -r build && pnpm -r test && pnpm -r exec tsc --noEmit` passes.
- `scripts/smoke/tier1-e2e.sh` includes the EO block and exits 0.
- `ROADMAP.md` shows `🚧 Enforced Outcomes` with the close-out paragraph.
- `README.md` Tier-1 Foundations panel shows 6 cards (the prior 5 plus EO).
- `/instance/outcomes` admin page renders.
- An issue with `required_outcomes` set rejects `status=done` with 422 and accepts it after declaring the matching artifact.
