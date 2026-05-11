// Plan-templates REST surface tests.
//
// Uses supertest against a lightweight in-memory express app.
// Auth is injected via a synthetic req.actor middleware (same pattern as outcomes.routes.test.ts).
// DB calls are stubbed with a minimal fake that records mutations.
//
// The planTemplatesRoutes factory delegates service logic to PlanTemplateService, which is a
// module-level singleton. Each test re-initialises the singleton via
// initializePlanTemplateService so the correct fake DB is in scope.

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { planTemplatesRoutes } from "../plan-templates.js";
import { initializePlanTemplateService } from "../../services/templates/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY_ID = "co-00000000-0000-0000-0000-000000000099";
const TEMPLATE_ID = "pt-00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Drizzle AST helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk drizzle condition AST chunks and detect an IS NULL check.
 * StringChunk.value is an array (e.g. [' is null']), not a plain string.
 */
function hasIsNullCheck(cond: any): boolean {
  if (!cond) return false;
  if (!Array.isArray(cond.queryChunks)) return false;
  for (const chunk of cond.queryChunks) {
    if (!chunk) continue;
    if (chunk.constructor?.name === "StringChunk") {
      const v = Array.isArray(chunk.value) ? chunk.value[0] : chunk.value;
      if (typeof v === "string" && v.toLowerCase().includes("is null")) return true;
    } else if (Array.isArray(chunk.queryChunks)) {
      if (hasIsNullCheck(chunk)) return true;
    }
  }
  return false;
}

/**
 * Recursively walk drizzle condition AST chunks and collect {columnName: value} pairs.
 * Structure: column node (PgUUID/PgTimestamp/etc), StringChunk(" = "), Param({value}).
 */
function extractEqPairs(cond: any): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};
  if (!cond) return pairs;

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
        // Next meaningful node: skip StringChunk(" = ") at i+2 (or look for Param after it)
        // Pattern: [ColumnNode, StringChunk(""), StringChunk(" = "), Param, StringChunk("")]
        // Actually from our inspection: [StringChunk(""), ColumnNode, StringChunk(" = "), Param, StringChunk("")]
        // So Param is at i+2
        const paramNode = chunks[i + 2];
        if (paramNode?.constructor?.name === "Param") {
          pairs[chunk.name] = paramNode.value;
        }
        continue;
      }
      if (Array.isArray(chunk.queryChunks)) {
        walk(chunk.queryChunks);
      }
    }
  }

  if (Array.isArray(cond.queryChunks)) {
    walk(cond.queryChunks);
  }
  return pairs;
}

/**
 * Filter rows using a drizzle-orm condition.
 * Handles: eq(col, val) and isNull(col) via AST traversal, plus and() combinations.
 */
function filterRows(rows: any[], condition?: any): any[] {
  if (!condition) return rows;
  const pairs = extractEqPairs(condition);
  const requireNotArchived = hasIsNullCheck(condition);

  return rows.filter((row) => {
    const eqMatch = Object.entries(pairs).every(([k, v]) => {
      if (v === undefined) return true;
      const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
      return row[camel] === v || row[k] === v;
    });
    if (requireNotArchived) return eqMatch && row.archivedAt == null;
    return eqMatch;
  });
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

function makeFakeDb(opts: { planTemplates?: any[] } = {}) {
  const store: Record<string, any[]> = {
    plan_templates: opts.planTemplates ? opts.planTemplates.map((r) => ({ ...r })) : [],
  };

  function resolveTableName(table: any): string {
    return table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "plan_templates";
  }

  const db = {
    _store: store,

    select(_projection?: any) {
      return {
        from(table: any) {
          const name = resolveTableName(table);
          return {
            where(condition: any): Promise<any[]> {
              return Promise.resolve(filterRows(store[name] ?? [], condition));
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
                  const matched = filterRows(store[name] ?? [], condition);
                  for (const row of matched) Object.assign(row, values);
                  return Promise.resolve(matched);
                },
                then(resolve: (v: any) => any, reject: (e: any) => any) {
                  const matched = filterRows(store[name] ?? [], condition);
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
          const row = { id: `pt-gen-${randomBytes(4).toString("hex")}`, archivedAt: null, ...vals };
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
// App factory
// ---------------------------------------------------------------------------

function makeApp(db: ReturnType<typeof makeFakeDb>, actor?: object) {
  // Re-initialise the singleton so this test's db is in scope for service calls.
  initializePlanTemplateService({ db: db as any });

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );

  // Inject synthetic actor (board + instance admin by default).
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

  app.use(planTemplatesRoutes(db as any));

  // Error handler: converts ZodError → 400, others by statusCode.
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err?.name === "ZodError") {
      return res.status(400).json({ error: "Validation error", details: err.errors });
    }
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

// ---------------------------------------------------------------------------
// POST /companies/:cid/plan-templates (create)
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/plan-templates", () => {
  it("creates a template → 201 with id", async () => {
    const db = makeFakeDb();
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates`)
      .send({
        name: "Sprint Template",
        description: "For sprints",
        default_required_outcomes: [{ kind: "manual_signoff" }],
        default_phases: ["planning", "execution"],
      })
      .expect(201);

    expect(typeof res.body.id).toBe("string");
    expect(res.body.name).toBe("Sprint Template");
  });

  it("returns 403 when actor has no access to the company", async () => {
    const db = makeFakeDb();
    const app = makeApp(db, {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-outsider",
      companyIds: [OTHER_COMPANY_ID],
      memberships: [],
    });

    await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates`)
      .send({ name: "X" })
      .expect(403);
  });

  it("returns 400 when name is missing", async () => {
    const db = makeFakeDb();
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates`)
      .send({ description: "no name" })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// GET /companies/:cid/plan-templates (list)
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/plan-templates", () => {
  it("returns 200 with array of active templates", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "My Template",
          archivedAt: null,
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates`)
      .expect(200);

    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThanOrEqual(1);
    expect(res.body.templates[0].id).toBe(TEMPLATE_ID);
  });

  it("does not include archived templates", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "Archived Template",
          archivedAt: new Date(),
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates`)
      .expect(200);

    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /companies/:cid/plan-templates/:id (single)
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/plan-templates/:id", () => {
  it("returns 200 with the row", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "My Template",
          archivedAt: null,
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}`)
      .expect(200);

    expect(res.body.id).toBe(TEMPLATE_ID);
    expect(res.body.name).toBe("My Template");
  });

  it("returns 404 when template not found", async () => {
    const db = makeFakeDb({ planTemplates: [] });
    const app = makeApp(db);

    await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates/no-such-id`)
      .expect(404);
  });

  it("returns 404 when template is archived (archived → null → 404)", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "Archived",
          archivedAt: new Date(),
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}`)
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /companies/:cid/plan-templates/:id (update)
// ---------------------------------------------------------------------------

describe("PATCH /companies/:cid/plan-templates/:id", () => {
  it("returns 200 with the patched row", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "Old Name",
          archivedAt: null,
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .patch(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}`)
      .send({ name: "New Name" })
      .expect(200);

    expect(res.body.name).toBe("New Name");
    expect(res.body.id).toBe(TEMPLATE_ID);
  });

  it("returns 404 when template not found", async () => {
    const db = makeFakeDb({ planTemplates: [] });
    const app = makeApp(db);

    await request(app)
      .patch(`/companies/${COMPANY_ID}/plan-templates/no-such-id`)
      .send({ name: "X" })
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/plan-templates/:id/archive
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/plan-templates/:id/archive", () => {
  it("archives template → 200 { ok: true }; subsequent GET single → 404", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "To Archive",
          archivedAt: null,
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const archiveRes = await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}/archive`)
      .send()
      .expect(200);

    expect(archiveRes.body.ok).toBe(true);

    // Subsequent GET single → 404 (archived treated as not found)
    await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}`)
      .expect(404);
  });

  it("returns 404 when template not found", async () => {
    const db = makeFakeDb({ planTemplates: [] });
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates/no-such-id/archive`)
      .send()
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/plan-templates/:id/restore
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/plan-templates/:id/restore", () => {
  it("restores archived template → 200; subsequent GET single → 200", async () => {
    const db = makeFakeDb({
      planTemplates: [
        {
          id: TEMPLATE_ID,
          companyId: COMPANY_ID,
          name: "To Restore",
          archivedAt: new Date(),
          defaultRequiredOutcomes: [],
          defaultPhases: [],
        },
      ],
    });
    const app = makeApp(db);

    const restoreRes = await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}/restore`)
      .send()
      .expect(200);

    expect(restoreRes.body.id).toBe(TEMPLATE_ID);

    // Subsequent GET single → 200 (no longer archived)
    const getRes = await request(app)
      .get(`/companies/${COMPANY_ID}/plan-templates/${TEMPLATE_ID}`)
      .expect(200);

    expect(getRes.body.id).toBe(TEMPLATE_ID);
  });

  it("returns 404 when template not found", async () => {
    const db = makeFakeDb({ planTemplates: [] });
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/plan-templates/no-such-id/restore`)
      .send()
      .expect(404);
  });
});
