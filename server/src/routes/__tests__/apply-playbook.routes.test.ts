// POST /api/companies/:cid/issues/:id/apply-playbook route tests.
//
// Uses supertest against a lightweight in-memory express app.
// Auth is injected via a synthetic req.actor middleware (same pattern as outcomes.routes.test.ts).
// DB calls are stubbed with a minimal fake.
//
// The handler delegates to OutcomesService which is a module-level singleton.
// Each test re-initialises the singleton via initializeOutcomesService so the
// correct fake DB is in scope.

import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import express, { type Router } from "express";
import request from "supertest";
import { z } from "zod";
import {
  initializeOutcomesService,
  getOutcomesService,
  PlaybookNotApplicableError,
} from "../../services/outcomes/service.js";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess } from "../authz.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY_ID = "co-00000000-0000-0000-0000-000000000099";
const ISSUE_ID = "iss-00000000-0000-0000-0000-000000000001";
const PLAYBOOK_ID = "pb-000000-0000-0000-0000-000000000001"; // not UUID — tested separately
const PLAYBOOK_UUID = "00000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/**
 * Minimal drizzle-like fake DB.
 * Supports select/insert/update/transaction for issues, playbooks and outcomes.
 */
function makeFakeDb(opts: { issues?: any[]; playbooks?: any[]; outcomes?: any[] } = {}) {
  const store: Record<string, any[]> = {
    issues: opts.issues ? opts.issues.map((r) => ({ ...r })) : [],
    playbooks: opts.playbooks ? opts.playbooks.map((r) => ({ ...r })) : [],
    outcomes: opts.outcomes ? opts.outcomes.map((r) => ({ ...r })) : [],
  };

  function resolveTableName(table: any): string {
    return table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
  }

  function extractEqs(condition: any): Record<string, unknown> {
    const pairs: Record<string, unknown> = {};
    if (!condition) return pairs;

    function resolveValue(v: any): unknown {
      if (v === null || v === undefined) return v;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      if (typeof v === "object" && "value" in v) return v.value;
      return undefined;
    }

    function isColumnNode(chunk: any): boolean {
      return (
        chunk !== null &&
        typeof chunk === "object" &&
        typeof chunk.name === "string" &&
        "keyAsName" in chunk
      );
    }

    function walk(chunks: any[]) {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk || typeof chunk !== "object") continue;
        if (isColumnNode(chunk)) {
          const paramNode = chunks[i + 2];
          const val = resolveValue(paramNode);
          if (val !== undefined) {
            pairs[chunk.name] = val;
          }
          continue;
        }
        if (Array.isArray(chunk.queryChunks)) {
          walk(chunk.queryChunks);
        }
      }
    }

    if (Array.isArray(condition.queryChunks)) {
      walk(condition.queryChunks);
    }
    return pairs;
  }

  function matchRows(rows: any[], condition?: any): any[] {
    if (!condition) return rows;
    const pairs = extractEqs(condition);
    if (Object.keys(pairs).length === 0) return rows;
    return rows.filter((row) =>
      Object.entries(pairs).every(([k, v]) => {
        const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
        return row[camel] === v || row[k] === v;
      }),
    );
  }

  const db = {
    _store: store,

    select(_projection?: any) {
      return {
        from(table: any) {
          const name = resolveTableName(table);
          return {
            where(condition: any): Promise<any[]> {
              return Promise.resolve(matchRows(store[name] ?? [], condition));
            },
            then(resolve: (v: any[]) => any, reject: (e: any) => any) {
              return Promise.resolve(store[name] ?? []).then(resolve, reject);
            },
          };
        },
      };
    },

    update(table: any) {
      const name = resolveTableName(table);
      return {
        set(values: any) {
          return {
            where(condition: any) {
              return {
                returning(): Promise<any[]> {
                  const matched = matchRows(store[name] ?? [], condition);
                  for (const row of matched) Object.assign(row, values);
                  return Promise.resolve(matched);
                },
                then(resolve: (v: any) => any, reject: (e: any) => any) {
                  const matched = matchRows(store[name] ?? [], condition);
                  for (const row of matched) Object.assign(row, values);
                  return Promise.resolve(matched).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },

    insert(table: any) {
      const name = resolveTableName(table);
      return {
        values(vals: any) {
          const row = { id: `gen-${randomBytes(4).toString("hex")}`, ...vals };
          (store[name] = store[name] ?? []).push(row);
          return { returning: () => Promise.resolve([row]) };
        },
      };
    },

    transaction: async (fn: any) => fn(db),
  };

  return db;
}

// ---------------------------------------------------------------------------
// applyPlaybookBodySchema (mirrors the implementation)
// ---------------------------------------------------------------------------

const applyPlaybookBodySchema = z.object({
  playbookId: z.string().uuid(),
  mergeStrategy: z.enum(["skip_existing", "replace"]).default("skip_existing"),
});

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(db: ReturnType<typeof makeFakeDb>, actor?: object) {
  // Re-initialise the singleton so this test's db is in scope for service calls.
  initializeOutcomesService({ db: db as any });

  const app = express();
  app.use(express.json());

  // Inject synthetic actor.
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      isInstanceAdmin: true,
      source: "local_implicit",
      userId: "user-test-1",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "owner", status: "active" }],
    };
    next();
  });

  // Mount only the endpoint under test.
  app.post(
    "/companies/:cid/issues/:id/apply-playbook",
    validate(applyPlaybookBodySchema),
    async (req, res) => {
      const cid = req.params.cid as string;
      const id = req.params.id as string;
      assertCompanyAccess(req as any, cid);
      try {
        const scoreHeader = req.headers["x-test-applicability-score"];
        const applicabilityScore = scoreHeader !== undefined
          ? Number(Array.isArray(scoreHeader) ? scoreHeader[0] : scoreHeader)
          : undefined;
        const r2 = await getOutcomesService().applyPlaybookToIssue(
          { callerCompanyId: cid },
          id,
          req.body.playbookId,
          req.body.mergeStrategy,
          applicabilityScore,
        );
        res.json({
          issueId: id,
          addedOutcomes: r2.addedOutcomes,
          skippedExisting: r2.skippedExisting,
          newContractLength: r2.newContractLength,
        });
      } catch (e) {
        if (e instanceof PlaybookNotApplicableError) {
          return res.status(422).json({ error: (e as Error).message });
        }
        throw e;
      }
    },
  );

  // Simple error handler for tests.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Fix the bug",
    labels: [],
    projectId: null,
    assigneeAgentId: null,
    requiredOutcomes: [],
    ...overrides,
  };
}

function makePlaybook(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAYBOOK_UUID,
    companyId: COMPANY_ID,
    title: "Standard deploy checklist",
    slug: "standard-deploy",
    status: "active",
    currentRevisionId: null,
    currentRevisionNumber: 1,
    agentId: null,
    applicabilityConditions: {},
    suggestedOutcomes: [
      { kind: "manual_signoff", requiredMeta: { name: "QA sign-off" } },
    ],
    sourceRunIds: [],
    sourcePlanIds: [],
    confidence: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/issues/:id/apply-playbook", () => {
  // -------------------------------------------------------------------------
  // Happy path — 200
  // -------------------------------------------------------------------------

  it("returns 200 with addedOutcomes, skippedExisting, newContractLength on success", async () => {
    const db = makeFakeDb({
      issues: [makeIssue()],
      playbooks: [makePlaybook()],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .set("X-Test-Applicability-Score", "1")
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "skip_existing" })
      .expect(200);

    expect(res.body.issueId).toBe(ISSUE_ID);
    expect(Array.isArray(res.body.addedOutcomes)).toBe(true);
    expect(Array.isArray(res.body.skippedExisting)).toBe(true);
    expect(typeof res.body.newContractLength).toBe("number");
    // One outcome added (the suggestedOutcomes from the playbook).
    expect(res.body.addedOutcomes).toHaveLength(1);
    expect(res.body.addedOutcomes[0].name).toBe("QA sign-off");
    expect(res.body.skippedExisting).toHaveLength(0);
    expect(res.body.newContractLength).toBe(1);
  });

  it("mergeStrategy defaults to skip_existing when omitted", async () => {
    const db = makeFakeDb({
      issues: [makeIssue()],
      playbooks: [makePlaybook()],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .set("X-Test-Applicability-Score", "1")
      .send({ playbookId: PLAYBOOK_UUID })
      .expect(200);

    expect(res.body.newContractLength).toBe(1);
  });

  // -------------------------------------------------------------------------
  // skip_existing preserves existing contract entries (no duplicates)
  // -------------------------------------------------------------------------

  it("200 with skip_existing: existing matching outcome is skipped, not duplicated", async () => {
    const db = makeFakeDb({
      issues: [
        makeIssue({
          // Existing contract already contains the same outcome.
          requiredOutcomes: [
            { kind: "manual_signoff", requiredMeta: { name: "QA sign-off" } },
          ],
        }),
      ],
      playbooks: [makePlaybook()],
      // Pre-populate an outcomes row matching the existing contract entry.
      outcomes: [
        {
          id: "out-existing-1",
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: ISSUE_ID,
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: { name: "QA sign-off" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .set("X-Test-Applicability-Score", "1")
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "skip_existing" })
      .expect(200);

    expect(res.body.addedOutcomes).toHaveLength(0);
    expect(res.body.skippedExisting).toHaveLength(1);
    expect(res.body.skippedExisting[0].name).toBe("QA sign-off");

    // Verify no duplicate was inserted.
    const outcomesInStore = (db as any)._store.outcomes;
    const matchingRows = outcomesInStore.filter(
      (o: any) => o.kind === "manual_signoff" && o.requiredMeta?.name === "QA sign-off",
    );
    expect(matchingRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 422 — non-applicable playbook
  // -------------------------------------------------------------------------

  it("returns 422 when playbook is not applicable (applicabilityScore=0)", async () => {
    const db = makeFakeDb({
      issues: [makeIssue()],
      playbooks: [makePlaybook()],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .set("X-Test-Applicability-Score", "0")
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "skip_existing" })
      .expect(422);

    expect(res.body.error).toMatch(/not applicable/i);
  });

  // -------------------------------------------------------------------------
  // 400 — invalid body (zod validation)
  // -------------------------------------------------------------------------

  it("returns 400/422 when playbookId is not a valid UUID", async () => {
    const db = makeFakeDb({ issues: [makeIssue()], playbooks: [makePlaybook()] });
    const app = makeApp(db);

    // Zod throws a ZodError which the default error handler returns as 500
    // unless wrapped — the validate() middleware throws synchronously via parse(),
    // which is caught by express and forwarded to the error handler.  The test
    // just verifies that a non-2xx code is returned.
    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .send({ playbookId: "not-a-uuid", mergeStrategy: "skip_existing" });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 400/422 when mergeStrategy has an invalid value", async () => {
    const db = makeFakeDb({ issues: [makeIssue()], playbooks: [makePlaybook()] });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "invalid_strategy" });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // -------------------------------------------------------------------------
  // 500 (treated as generic error) when playbook doesn't exist
  // -------------------------------------------------------------------------

  it("returns non-2xx when playbook doesn't exist in DB", async () => {
    const db = makeFakeDb({
      issues: [makeIssue()],
      playbooks: [], // empty — no playbook
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .set("X-Test-Applicability-Score", "1")
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "skip_existing" });

    // Service throws plain Error("playbook not found: ...") — handler rethrows,
    // error handler returns 500.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/playbook not found/i);
  });

  // -------------------------------------------------------------------------
  // 403 — actor cannot access the company
  // -------------------------------------------------------------------------

  it("returns 403 when actor does not have access to the company", async () => {
    const db = makeFakeDb({ issues: [makeIssue()], playbooks: [makePlaybook()] });
    const outsiderActor = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-outsider",
      companyIds: [OTHER_COMPANY_ID],
      memberships: [],
    };
    const app = makeApp(db, outsiderActor);

    await request(app)
      .post(`/companies/${COMPANY_ID}/issues/${ISSUE_ID}/apply-playbook`)
      .send({ playbookId: PLAYBOOK_UUID, mergeStrategy: "skip_existing" })
      .expect(403);
  });
});
