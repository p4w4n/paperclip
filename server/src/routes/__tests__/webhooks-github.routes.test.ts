// GitHub webhook REST surface tests.
//
// Uses supertest against a lightweight in-memory express app.
// Auth is injected via a synthetic req.actor middleware (same pattern as outcomes.routes.test.ts).
// DB calls are stubbed with a minimal fake that records mutations.

import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { webhooksRoutes } from "../webhooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY_ID = "co-00000000-0000-0000-0000-000000000099";
const OUTCOME_ID = "out-0000-0000-0000-0000-000000000001";
const ISSUE_ID = "iss-0000-0000-0000-0000-000000000001";
const GH_SECRET = "ghw_" + "a".repeat(64);

function hmacSig(body: string, secret = GH_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function mergedPrPayload(opts: {
  title?: string;
  body?: string;
  branch?: string;
  action?: string;
  merged?: boolean;
} = {}): string {
  return JSON.stringify({
    action: opts.action ?? "closed",
    pull_request: {
      number: 42,
      html_url: "https://github.com/test/repo/pull/42",
      title: opts.title ?? "Fix PAP-1: some issue",
      body: opts.body ?? "",
      merged: opts.merged !== undefined ? opts.merged : true,
      head: { ref: opts.branch ?? "fix/PAP-1-something" },
    },
  });
}

function openedPrPayload(): string {
  return JSON.stringify({
    action: "opened",
    pull_request: {
      number: 5,
      html_url: "https://github.com/test/repo/pull/5",
      title: "Add feature",
      body: "",
      merged: false,
      head: { ref: "feature/add-stuff" },
    },
  });
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

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

function makeFakeDb(opts: {
  companies?: any[];
  outcomes?: any[];
  issues?: any[];
  github_webhook_deliveries?: any[];
} = {}) {
  const store: Record<string, any[]> = {
    companies: opts.companies ? opts.companies.map((r) => ({ ...r })) : [],
    outcomes: opts.outcomes ? opts.outcomes.map((r) => ({ ...r })) : [],
    issues: opts.issues ? opts.issues.map((r) => ({ ...r })) : [],
    github_webhook_deliveries: opts.github_webhook_deliveries
      ? opts.github_webhook_deliveries.map((r) => ({ ...r }))
      : [],
  };

  const db: any = {
    _store: store,

    select(_projection?: any) {
      return {
        from(table: any) {
          const name = resolveTableName(table);
          return {
            where(condition: any) {
              return {
                orderBy(_order?: any) {
                  return {
                    limit(_n?: number): Promise<any[]> {
                      return Promise.resolve(matchRows(store[name] ?? [], condition));
                    },
                    then(resolve: (v: any[]) => any, reject: (e: any) => any) {
                      return Promise.resolve(matchRows(store[name] ?? [], condition)).then(
                        resolve,
                        reject,
                      );
                    },
                  };
                },
                then(resolve: (v: any[]) => any, reject: (e: any) => any) {
                  return Promise.resolve(matchRows(store[name] ?? [], condition)).then(
                    resolve,
                    reject,
                  );
                },
              };
            },
            orderBy(_order?: any) {
              return {
                limit(_n?: number): Promise<any[]> {
                  return Promise.resolve(store[name] ?? []);
                },
              };
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
          return {
            returning: () => Promise.resolve([row]),
            then(resolve: (v: any) => any, reject: (e: any) => any) {
              return Promise.resolve(row).then(resolve, reject);
            },
          };
        },
      };
    },

    transaction: async (fn: any) => fn(db),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Default company row
// ---------------------------------------------------------------------------

// A deliberately DIFFERENT secret to confirm that ingestExternalSignal no longer
// re-checks HMAC (it uses skipHmacVerify: true via the GitHub adapter). If the
// adapter were still delegating with the wrong secret, the happy-path "verified"
// test would fail with SignalAuthError instead of flipping the outcome.
const OUTCOME_SIGNAL_SECRET = "outcome-signal-secret-different-from-gh";

function makeCompany(overrides?: any) {
  return {
    id: COMPANY_ID,
    issuePrefix: "PAP",
    githubWebhookSecret: GH_SECRET,
    outcomeSignalSecret: OUTCOME_SIGNAL_SECRET,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(db: ReturnType<typeof makeFakeDb>, actor?: object) {
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

  app.use(webhooksRoutes(db as any));

  // Simple error handler for tests.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

// ---------------------------------------------------------------------------
// POST /companies/:cid/webhooks/github — ingest
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/webhooks/github", () => {
  it("returns 401 on invalid HMAC signature", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const app = makeApp(db);
    const body = mergedPrPayload();

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-001")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", "sha256=badhex")
      .send(body)
      .expect(401);

    expect(res.body.result).toBe("invalid_signature");
    // Audit row should have been written
    const deliveries = db._store.github_webhook_deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].result).toBe("invalid_signature");
    expect(deliveries[0].signatureValid).toBe(false);
  });

  it("returns 200 ignored on action=opened", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const app = makeApp(db);
    const body = openedPrPayload();

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-002")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(200);

    expect(res.body.result).toBe("ignored");
    const deliveries = db._store.github_webhook_deliveries;
    expect(deliveries[0].result).toBe("ignored");
    expect(deliveries[0].signatureValid).toBe(true);
  });

  it("returns 200 ignored on action=closed but merged=false", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const app = makeApp(db);
    const body = mergedPrPayload({ merged: false });

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-003")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(200);

    expect(res.body.result).toBe("ignored");
  });

  it("returns 200 verified on action=closed + merged=true + matching outcome", async () => {
    const body = mergedPrPayload({
      title: "fix PAP-1: closes the thing",
      body: "",
      branch: "fix/PAP-1",
    });

    const db = makeFakeDb({
      companies: [makeCompany()],
      issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, identifier: "PAP-1" }],
      outcomes: [
        {
          id: OUTCOME_ID,
          companyId: COMPANY_ID,
          targetKind: "issue",
          targetId: ISSUE_ID,
          kind: "external_signal",
          status: "pending",
          requiredMeta: { source: "github" },
        },
      ],
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-verified-001")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(200);

    expect(res.body.result).toBe("verified");
    expect(res.body.verified).toBe(true);
    expect(res.body.matchedOutcomes).toContain(OUTCOME_ID);

    // Audit row
    const deliveries = db._store.github_webhook_deliveries;
    expect(deliveries[0].result).toBe("verified");
    expect(deliveries[0].outcomeId).toBe(OUTCOME_ID);

    // Outcome should now be verified
    const outcome = db._store.outcomes.find((o: any) => o.id === OUTCOME_ID);
    expect(outcome.status).toBe("verified");
  });

  it("returns 200 replay on duplicate X-GitHub-Delivery", async () => {
    const existingDelivery = {
      id: "deliv-existing",
      companyId: COMPANY_ID,
      deliveryId: "delivery-dup-001",
      eventType: "pull_request",
      action: "closed",
      prUrl: "https://github.com/test/repo/pull/42",
      outcomeId: OUTCOME_ID,
      signatureValid: true,
      result: "verified",
      rawBodySha256: "abc123",
      receivedAt: new Date(),
    };

    const db = makeFakeDb({
      companies: [makeCompany()],
      github_webhook_deliveries: [existingDelivery],
    });
    const app = makeApp(db);
    const body = mergedPrPayload();

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-dup-001")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(200);

    expect(res.body.replay).toBe(true);
    expect(res.body.result).toBe("verified");
    expect(res.body.verified).toBe(true);
    // No new audit row written
    expect(db._store.github_webhook_deliveries).toHaveLength(1);
  });

  it("returns 200 no_match when no contract entry matches the PR", async () => {
    // Merged PR with valid sig, issue exists, but no external_signal outcome
    const body = mergedPrPayload({
      title: "fix PAP-1: closes the thing",
    });

    const db = makeFakeDb({
      companies: [makeCompany()],
      issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, identifier: "PAP-1" }],
      outcomes: [], // no outcomes
    });
    const app = makeApp(db);

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-nomatch-001")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(200);

    expect(res.body.result).toBe("no_match");
    expect(res.body.verified).toBe(false);
  });

  it("returns 404 when company has not configured a webhook secret", async () => {
    const db = makeFakeDb({
      companies: [makeCompany({ githubWebhookSecret: null })],
    });
    const app = makeApp(db);
    const body = mergedPrPayload();

    await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github`)
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-nosecret")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", hmacSig(body))
      .send(body)
      .expect(404);
  });
});

// ---------------------------------------------------------------------------
// POST /companies/:cid/webhooks/github/_secret/rotate
// ---------------------------------------------------------------------------

describe("POST /companies/:cid/webhooks/github/_secret/rotate", () => {
  it("generates a fresh ghw_ secret and updates company row (admin)", async () => {
    const db = makeFakeDb({
      companies: [makeCompany({ githubWebhookSecret: null })],
    });
    const app = makeApp(db); // default actor = instance admin

    const res = await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github/_secret/rotate`)
      .expect(200);

    expect(res.body.secret).toMatch(/^ghw_[0-9a-f]{64}$/);
    expect(typeof res.body.instructions).toBe("string");

    // Company row should be updated
    const co = db._store.companies.find((c: any) => c.id === COMPANY_ID);
    expect(co.githubWebhookSecret).toBe(res.body.secret);
  });

  it("returns 403 when actor is not admin", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const nonAdminActor = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-pleb",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
    };
    const app = makeApp(db, nonAdminActor);

    await request(app)
      .post(`/companies/${COMPANY_ID}/webhooks/github/_secret/rotate`)
      .expect(403);
  });
});

// ---------------------------------------------------------------------------
// GET /companies/:cid/webhooks/github/deliveries
// ---------------------------------------------------------------------------

describe("GET /companies/:cid/webhooks/github/deliveries", () => {
  it("returns last 50 deliveries in reverse-chrono order", async () => {
    const now = Date.now();
    const deliveries = Array.from({ length: 3 }, (_, i) => ({
      id: `deliv-${i}`,
      companyId: COMPANY_ID,
      deliveryId: `d-${i}`,
      eventType: "pull_request",
      action: "closed",
      prUrl: null,
      outcomeId: null,
      signatureValid: true,
      result: "ignored",
      rawBodySha256: "abc",
      receivedAt: new Date(now - i * 1000),
    }));

    const db = makeFakeDb({
      companies: [makeCompany()],
      github_webhook_deliveries: deliveries,
    });
    const app = makeApp(db);

    const res = await request(app)
      .get(`/companies/${COMPANY_ID}/webhooks/github/deliveries`)
      .expect(200);

    expect(Array.isArray(res.body.deliveries)).toBe(true);
    // All 3 rows returned (limit 50)
    expect(res.body.deliveries).toHaveLength(3);
  });

  it("returns 401 when actor is unauthenticated", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const app = makeApp(db, { type: "none" });

    await request(app)
      .get(`/companies/${COMPANY_ID}/webhooks/github/deliveries`)
      .expect(401);
  });

  it("returns 403 when actor does not have access to the company", async () => {
    const db = makeFakeDb({ companies: [makeCompany()] });
    const outsider = {
      type: "board",
      isInstanceAdmin: false,
      source: "session",
      userId: "user-outsider",
      companyIds: [OTHER_COMPANY_ID],
      memberships: [],
    };
    const app = makeApp(db, outsider);

    await request(app)
      .get(`/companies/${COMPANY_ID}/webhooks/github/deliveries`)
      .expect(403);
  });
});
