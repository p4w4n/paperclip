// Outcomes REST surface tests.
//
// Uses supertest against a lightweight in-memory express app.
// Auth is injected via a synthetic req.actor middleware (same pattern as _workers.test.ts).
// DB calls are stubbed with a minimal fake that records mutations.
//
// The outcomesRoutes factory delegates service logic to OutcomesService, which is a
// module-level singleton. Each test re-initialises the singleton via
// initializeOutcomesService so the correct fake DB is in scope.

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, createHash, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { outcomesRoutes } from "../outcomes.js";
import { initializeOutcomesService } from "../../services/outcomes/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY_ID = "co-00000000-0000-0000-0000-000000000099";
const OUTCOME_ID = "out-0000-0000-0000-0000-000000000001";
const SECRET = "test-secret-" + "x".repeat(20);

function hmacSig(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/**
 * Minimal drizzle-like fake DB for outcomes routes.
 * Stores outcomes rows and companies rows; supports select/update/insert by table name.
 */
function makeFakeDb(
  opts: {
    outcomes?: any[];
    companies?: any[];
  } = {},
) {
  const store: Record<string, any[]> = {
    outcomes: opts.outcomes ? opts.outcomes.map((r) => ({ ...r })) : [],
    companies: opts.companies ? opts.companies.map((r) => ({ ...r })) : [],
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
            // With WHERE
            where(condition: any): Promise<any[]> {
              return Promise.resolve(matchRows(store[name] ?? [], condition));
            },
            // Without WHERE (used by GET /instance/outcomes)
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
                // No-returning variant (used by rotate)
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
// App factory
// ---------------------------------------------------------------------------

function makeApp(db: ReturnType<typeof makeFakeDb>, actor?: object) {
  // Re-initialise the singleton so this test's db is in scope for service calls.
  initializeOutcomesService({ db: db as any });

  const app = express();
  // Mirror app.ts: express.json with rawBody capture.
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

  app.use(outcomesRoutes(db as any));

  // Simple error handler for tests.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

// ---------------------------------------------------------------------------
// GET /companies/:cid/outcomes
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/outcomes", () => {
  it("returns 200 + array of outcomes for target", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: { name: "QA" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes?target_kind=issue&target_id=iss-1`)
      .expect(200);

    expect(Array.isArray(res.body.outcomes)).toBe(true);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0].id).toBe(OUTCOME_ID);
  });

  it("returns all company outcomes when no target filter given", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes`)
      .expect(200);

    expect(Array.isArray(res.body.outcomes)).toBe(true);
    expect(res.body.outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 403 when actor has no access to the company", async () => {
    const db = makeFakeDb({ outcomes: [] });
    const app = makeApp(db, {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-outsider",
      companyIds: [OTHER_COMPANY_ID],
      memberships: [],
    });

    await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes`)
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// GET /companies/:cid/outcomes/:id
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/outcomes/:id", () => {
  it("returns 200 + outcome row", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}`)
      .expect(200);

    expect(res.body.outcome.id).toBe(OUTCOME_ID);
  });

  it("returns 404 when outcome not found or belongs to other company", async () => {
    const db = makeFakeDb({ outcomes: [] });
    const app = makeApp(db);

    await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes/no-such-id`)
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/outcomes/:id/signoff
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/outcomes/:id/signoff", () => {
  it("verifies a manual_signoff outcome (200 + verifiedCount)", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signoff`)
      .send({})
      .expect(200);

    expect(res.body.verifiedCount).toBe(1);
  });

  it("returns 403 when role does not match required_role", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: { required_role: "admin" },
        },
      ],
    });
    const actor = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-engineer",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
    };
    const app = makeApp(db, actor);

    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signoff`)
      .send({})
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/outcomes/:id/signal  (HMAC + Idempotency-Key)
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/outcomes/:id/signal", () => {
  const rawBody = JSON.stringify({ event: "deploy.success", ref: "v1.2.3" });

  it("returns 400 when Idempotency-Key header is missing", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          kind: "external_signal",
          status: "pending",
          requiredMeta: {},
          verifiedMeta: null,
        },
      ],
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: SECRET }],
    });
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signal`)
      .set("Content-Type", "application/json")
      .set("X-Signature-256", hmacSig(rawBody))
      // no Idempotency-Key header
      .send(rawBody)
      .expect(400);
  });

  it("returns 401 with bad HMAC signature", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          kind: "external_signal",
          status: "pending",
          requiredMeta: {},
          verifiedMeta: null,
        },
      ],
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: SECRET }],
    });
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signal`)
      .set("Content-Type", "application/json")
      .set("X-Signature-256", "sha256=" + "0".repeat(64))
      .set("Idempotency-Key", "idem-bad-1")
      .send(rawBody)
      .expect(401);
  });

  it("returns 200 + verified=true on first valid signal", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          kind: "external_signal",
          status: "pending",
          requiredMeta: {},
          verifiedMeta: null,
        },
      ],
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: SECRET }],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signal`)
      .set("Content-Type", "application/json")
      .set("X-Signature-256", hmacSig(rawBody))
      .set("Idempotency-Key", "idem-valid-1")
      .send(rawBody)
      .expect(200);

    expect(res.body.verified).toBe(true);
    expect(res.body.replay).toBe(false);
  });

  it("returns 200 idempotent on replay (same key + same body)", async () => {
    // Pre-verified state — idempotencyKey already stored in verifiedMeta.
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          kind: "external_signal",
          status: "verified",
          requiredMeta: {},
          verifiedMeta: {
            idempotency_key: "idem-replay-1",
            payload_sha256: payloadSha256,
            signature_verified: true,
          },
        },
      ],
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: SECRET }],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signal`)
      .set("Content-Type", "application/json")
      .set("X-Signature-256", hmacSig(rawBody))
      .set("Idempotency-Key", "idem-replay-1")
      .send(rawBody)
      .expect(200);

    expect(res.body.verified).toBe(true);
    expect(res.body.replay).toBe(true);
  });

  it("returns 409 on idempotency-key conflict (different body, same key)", async () => {
    const originalBody = JSON.stringify({ event: "original" });
    const originalSha = createHash("sha256").update(originalBody).digest("hex");
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          kind: "external_signal",
          status: "verified",
          requiredMeta: {},
          verifiedMeta: {
            idempotency_key: "idem-conflict-1",
            payload_sha256: originalSha,
            signature_verified: true,
          },
        },
      ],
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: SECRET }],
    });
    const app = makeApp(db);

    // Different body but same idempotency key.
    // Must set Content-Type: application/json so express.json populates req.rawBody.
    const differentBody = JSON.stringify({ event: "different" });
    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/signal`)
      .set("Content-Type", "application/json")
      .set("X-Signature-256", hmacSig(differentBody))
      .set("Idempotency-Key", "idem-conflict-1")
      .send(differentBody)
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/outcomes/:id/revert
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/outcomes/:id/revert", () => {
  it("flips a verified outcome to reverted (200)", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "verified",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/revert`)
      .send({ reason: "Rollback" })
      .expect(200);

    // Response now spreads the outcome row directly (with parent_reopened + slot_still_satisfied).
    expect(res.body.id).toBeDefined();
    expect(typeof res.body.parent_reopened).toBe("boolean");
    expect(typeof res.body.slot_still_satisfied).toBe("boolean");
  });

  it("returns 409 when outcome is not in verified state", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/revert`)
      .send({ reason: "Oops" })
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/outcomes/_secrets/signal/rotate
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/outcomes/_secrets/signal/rotate", () => {
  it("generates a new secret for the company and returns it (admin only)", async () => {
    const db = makeFakeDb({
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: null }],
    });
    const app = makeApp(db); // default actor is instance admin

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/_secrets/signal/rotate`)
      .send()
      .expect(200);

    expect(typeof res.body.secret).toBe("string");
    expect(res.body.secret.length).toBeGreaterThan(0);
  });

  it("returns 403 when caller is not instance admin", async () => {
    const db = makeFakeDb({
      companies: [{ id: COMPANY_ID, outcomeSignalSecret: null }],
    });
    const actor = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-plain",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
    };
    const app = makeApp(db, actor);

    await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/_secrets/signal/rotate`)
      .send()
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// GET /companies/:cid/outcomes — alias context
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/outcomes — alias context", () => {
  it("each row includes slot_base_name + slot_satisfied + alternatives[]", async () => {
    // One slot "QA" with primary + 1 alternative, both pending.
    const PRIMARY_ID = "out-primary-0000-0000-0000-000000000001";
    const ALT_ID = "out-alt-0000-0000-0000-0000-000000000002";
    const db = makeFakeDb({
      outcomes: [
        {
          id: PRIMARY_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-alias-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: { name: "QA" },
        },
        {
          id: ALT_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-alias-1",
          kind: "external_signal",
          status: "pending",
          requiredMeta: { name: "QA:alt:0" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes?target_kind=issue&target_id=iss-alias-1`)
      .expect(200);

    expect(res.body.outcomes).toHaveLength(2);

    const primary = res.body.outcomes.find((r: any) => r.id === PRIMARY_ID);
    const alt = res.body.outcomes.find((r: any) => r.id === ALT_ID);

    // Primary row assertions
    expect(primary).toBeDefined();
    expect(primary.slot_base_name).toBe("QA");
    expect(primary.slot_satisfied).toBe(false);
    expect(Array.isArray(primary.alternatives)).toBe(true);
    expect(primary.alternatives).toHaveLength(1);
    expect(primary.alternatives[0].id).toBe(ALT_ID);

    // Alt row assertions
    expect(alt).toBeDefined();
    expect(alt.slot_base_name).toBe("QA");
    expect(alt.slot_satisfied).toBe(false);
    expect(Array.isArray(alt.alternatives)).toBe(true);
    expect(alt.alternatives).toHaveLength(0);
  });

  it("slot_satisfied=true when any sibling is verified", async () => {
    const PRIMARY_ID = "out-primary-0000-0000-0000-000000000003";
    const ALT_ID = "out-alt-0000-0000-0000-0000-000000000004";
    const db = makeFakeDb({
      outcomes: [
        {
          id: PRIMARY_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-alias-2",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: { name: "QA" },
        },
        {
          id: ALT_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-alias-2",
          kind: "external_signal",
          status: "verified",
          requiredMeta: { name: "QA:alt:0" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/outcomes?target_kind=issue&target_id=iss-alias-2`)
      .expect(200);

    const primary = res.body.outcomes.find((r: any) => r.id === PRIMARY_ID);
    expect(primary.slot_satisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/outcomes/:id/revert — alias context
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/outcomes/:id/revert — alias context", () => {
  it("response includes parent_reopened + slot_still_satisfied", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-revert-alias",
          kind: "manual_signoff",
          status: "verified",
          requiredMeta: { name: "QA" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/outcomes/${OUTCOME_ID}/revert`)
      .send({ reason: "operator" })
      .expect(200);

    expect(typeof res.body.parent_reopened).toBe("boolean");
    expect(typeof res.body.slot_still_satisfied).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// GET /instance/outcomes  (instance admin)
// ---------------------------------------------------------------------------

describe("GET /instance/outcomes", () => {
  it("returns 200 + all outcomes across companies (admin only)", async () => {
    const db = makeFakeDb({
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: "iss-1",
          kind: "manual_signoff",
          status: "pending",
          requiredMeta: {},
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app).get("/instance/outcomes").expect(200);

    expect(Array.isArray(res.body.outcomes)).toBe(true);
    expect(res.body.outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 403 when caller is not instance admin", async () => {
    const db = makeFakeDb({ outcomes: [] });
    const actor = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-plain",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
    };
    const app = makeApp(db, actor);

    await request(app).get("/instance/outcomes").expect(403);
  });
});
