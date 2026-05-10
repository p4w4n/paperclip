import { describe, expect, it, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { initializeOutcomesService, getOutcomesService } from "../service.js";
import { OutcomeRequiredError } from "../types.js";
import { SignoffRoleMismatchError, SignalAuthError } from "../verifiers/index.js";

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

// ---------------------------------------------------------------------------
// Helpers for signOff / ingestSignal service method tests
// ---------------------------------------------------------------------------

/**
 * Extract { columnName: value } pairs from a drizzle `and(eq(...), ...)` node.
 * (Duplicated from verifiers.test.ts to keep test files self-contained.)
 */
function extractEqsSvc(condition: any): Record<string, unknown> {
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

function makeMultiTableFakeDbSvc(tableRows: Record<string, any[]>) {
  const store: Record<string, any[]> = {};
  for (const [k, rows] of Object.entries(tableRows)) {
    store[k] = rows.map((r) => ({ ...r }));
  }

  const db = {
    allRows: store,

    select(_projection?: any) {
      return {
        from(table: any) {
          const tableName: string =
            table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
          return {
            where(condition: any): Promise<any[]> {
              const rows: any[] = store[tableName] ?? [];
              const filters = extractEqsSvc(condition);
              const matched = rows.filter((row) =>
                Object.entries(filters).every(([k, v]) => {
                  const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
                  return row[camel] === v || row[k] === v;
                }),
              );
              return Promise.resolve(matched);
            },
          };
        },
      };
    },

    update(table: any) {
      const tableName: string =
        table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
      return {
        set(values: any) {
          return {
            where(condition: any) {
              return {
                returning(): Promise<any[]> {
                  const rows: any[] = store[tableName] ?? [];
                  const filters = extractEqsSvc(condition);
                  const matched = rows.filter((row) =>
                    Object.entries(filters).every(([k, v]) => {
                      const camel = k.replace(/_([a-z])/g, (_: string, c: string) =>
                        c.toUpperCase(),
                      );
                      return row[camel] === v || row[k] === v;
                    }),
                  );
                  for (const row of matched) {
                    Object.assign(row, values);
                  }
                  return Promise.resolve(matched);
                },
              };
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
// OutcomesService.signOff tests
// ---------------------------------------------------------------------------

describe("OutcomesService — signOff", () => {
  it("delegates to verifyManualSignoff and flips outcome to verified", async () => {
    const outcomeRow = {
      id: "out-ms-svc-1",
      companyId: "co-1",
      kind: "manual_signoff",
      status: "pending",
      requiredMeta: {},
    };
    const db = makeMultiTableFakeDbSvc({ outcomes: [outcomeRow] });
    const svc = initializeOutcomesService({ db: db as any });

    const result = await svc.signOff({
      outcomeId: "out-ms-svc-1",
      companyId: "co-1",
      userId: "user-7",
      userRole: null,
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.allRows["outcomes"][0].status).toBe("verified");
  });

  it("propagates SignoffRoleMismatchError when required_role mismatches", async () => {
    const outcomeRow = {
      id: "out-ms-svc-2",
      companyId: "co-1",
      kind: "manual_signoff",
      status: "pending",
      requiredMeta: { required_role: "admin" },
    };
    const db = makeMultiTableFakeDbSvc({ outcomes: [outcomeRow] });
    const svc = initializeOutcomesService({ db: db as any });

    await expect(
      svc.signOff({
        outcomeId: "out-ms-svc-2",
        companyId: "co-1",
        userId: "user-7",
        userRole: "engineer",
      }),
    ).rejects.toThrow(SignoffRoleMismatchError);
  });
});

// ---------------------------------------------------------------------------
// OutcomesService.ingestSignal tests
// ---------------------------------------------------------------------------

const SVC_SECRET = "svc-secret-key";

function makeSvcHmacSig(body: string): string {
  return "sha256=" + createHmac("sha256", SVC_SECRET).update(body).digest("hex");
}

describe("OutcomesService — ingestSignal", () => {
  it("delegates to ingestExternalSignal and flips outcome on valid HMAC", async () => {
    const rawBody = JSON.stringify({ event: "release" });
    const sig = makeSvcHmacSig(rawBody);
    const outcomeRow = {
      id: "out-es-svc-1",
      companyId: "co-svc-1",
      kind: "external_signal",
      status: "pending",
      requiredMeta: {},
      verifiedMeta: null,
    };
    const companyRow = { id: "co-svc-1", outcomeSignalSecret: SVC_SECRET };
    const db = makeMultiTableFakeDbSvc({
      outcomes: [outcomeRow],
      companies: [companyRow],
    });
    const svc = initializeOutcomesService({ db: db as any });

    const result = await svc.ingestSignal({
      outcomeId: "out-es-svc-1",
      companyId: "co-svc-1",
      rawBody,
      signature: sig,
      idempotencyKey: "svc-idem-1",
    });

    expect(result.verified).toBe(true);
    expect(result.replay).toBe(false);
    expect(db.allRows["outcomes"][0].status).toBe("verified");
  });

  it("propagates SignalAuthError on bad HMAC", async () => {
    const rawBody = JSON.stringify({ event: "release" });
    const badSig = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    const outcomeRow = {
      id: "out-es-svc-2",
      companyId: "co-svc-1",
      kind: "external_signal",
      status: "pending",
      requiredMeta: {},
      verifiedMeta: null,
    };
    const companyRow = { id: "co-svc-1", outcomeSignalSecret: SVC_SECRET };
    const db = makeMultiTableFakeDbSvc({
      outcomes: [outcomeRow],
      companies: [companyRow],
    });
    const svc = initializeOutcomesService({ db: db as any });

    await expect(
      svc.ingestSignal({
        outcomeId: "out-es-svc-2",
        companyId: "co-svc-1",
        rawBody,
        signature: badSig,
        idempotencyKey: "svc-idem-bad",
      }),
    ).rejects.toThrow(SignalAuthError);
  });
});
