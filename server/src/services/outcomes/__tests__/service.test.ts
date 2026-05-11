import { describe, expect, it, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { initializeOutcomesService, getOutcomesService, PlaybookNotApplicableError } from "../service.js";
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

describe("materializeContract — alternatives", () => {
  it("expands one entry with N alternatives into N+1 pending rows", async () => {
    const fakeDb = makeFakeDb();
    const altSvc = initializeOutcomesService({ db: fakeDb as any });

    await altSvc.materializeContract(
      { kind: "issue", id: "iss-alt-1", companyId: "co-1" },
      [{
        kind: "artifact_declared",
        requiredMeta: { name: "patch", artifact_kind: "code.patch" },
        alternatives: [
          { kind: "artifact_declared", requiredMeta: { artifact_kind: "code.patch" } },
          { kind: "artifact_declared", requiredMeta: { artifact_kind: "code.patch" } },
        ],
      } as any],
    );

    // Should have 3 rows: "patch", "patch:alt:0", "patch:alt:1"
    expect(fakeDb.rows).toHaveLength(3);
    const names = fakeDb.rows.map((r: any) => r.requiredMeta.name);
    expect(names).toContain("patch");
    expect(names).toContain("patch:alt:0");
    expect(names).toContain("patch:alt:1");
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
              const applyUpdate = (): any[] => {
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
                return matched;
              };
              // Make the returned object both thenable (for await without .returning())
              // and have a .returning() method (for callers that chain it).
              return {
                then(resolve: any, reject: any) {
                  try {
                    resolve(applyUpdate());
                  } catch (e) {
                    reject(e);
                  }
                },
                returning(): Promise<any[]> {
                  return Promise.resolve(applyUpdate());
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

// ---------------------------------------------------------------------------
// OutcomesService.revertOutcome — auto-reopen path (EO-P2-11)
// ---------------------------------------------------------------------------

describe("revertOutcome — auto-reopen path", () => {
  it("reopens parent issue when auto_reopen_on_revert flag is true and no sibling covers slot", async () => {
    const outcomeRow = {
      id: "out-revert-1",
      companyId: "co-r",
      kind: "artifact_declared",
      status: "verified",
      targetKind: "issue",
      targetId: "iss-r-1",
      requiredMeta: { name: "patch", artifact_kind: "code.patch", auto_reopen_on_revert: true },
      revertedAt: null,
      revertedReason: null,
    };
    const issueRow = { id: "iss-r-1", companyId: "co-r", status: "done", completedAt: new Date() };
    const db = makeMultiTableFakeDbSvc({ outcomes: [outcomeRow], issues: [issueRow] });
    const svc = initializeOutcomesService({ db: db as any });
    const result = await svc.revertOutcome("out-revert-1", "test-reason");

    expect(result.parentReopened).toBe(true);
    expect(result.slotStillSatisfied).toBe(false);
    expect(db.allRows["issues"][0].status).toBe("in_progress");
    expect(db.allRows["issues"][0].completedAt).toBeNull();
  });

  it("does NOT reopen when an alternative still covers the slot", async () => {
    const primaryRow = {
      id: "out-revert-2",
      companyId: "co-r",
      kind: "artifact_declared",
      status: "verified",
      targetKind: "issue",
      targetId: "iss-r-2",
      requiredMeta: { name: "patch", artifact_kind: "code.patch", auto_reopen_on_revert: true },
      revertedAt: null,
      revertedReason: null,
    };
    const altRow = {
      id: "out-revert-2-alt",
      companyId: "co-r",
      kind: "artifact_declared",
      status: "verified",
      targetKind: "issue",
      targetId: "iss-r-2",
      requiredMeta: { name: "patch:alt:0", artifact_kind: "code.patch" },
    };
    const issueRow = { id: "iss-r-2", companyId: "co-r", status: "done", completedAt: new Date() };
    const db = makeMultiTableFakeDbSvc({ outcomes: [primaryRow, altRow], issues: [issueRow] });
    const svc = initializeOutcomesService({ db: db as any });
    const result = await svc.revertOutcome("out-revert-2", "test-reason");

    expect(result.parentReopened).toBe(false);
    expect(result.slotStillSatisfied).toBe(true);
    // Issue stays done because alt covers the slot
    expect(db.allRows["issues"][0].status).toBe("done");
  });

  it("does NOT reopen when flag is false", async () => {
    const outcomeRow = {
      id: "out-revert-3",
      companyId: "co-r",
      kind: "artifact_declared",
      status: "verified",
      targetKind: "issue",
      targetId: "iss-r-3",
      requiredMeta: { name: "patch", artifact_kind: "code.patch" }, // no auto_reopen_on_revert
      revertedAt: null,
      revertedReason: null,
    };
    const issueRow = { id: "iss-r-3", companyId: "co-r", status: "done", completedAt: new Date() };
    const db = makeMultiTableFakeDbSvc({ outcomes: [outcomeRow], issues: [issueRow] });
    const svc = initializeOutcomesService({ db: db as any });
    const result = await svc.revertOutcome("out-revert-3", "test-reason");

    expect(result.parentReopened).toBe(false);
    expect(result.slotStillSatisfied).toBe(false);
    expect(db.allRows["issues"][0].status).toBe("done");
  });

  it("revert succeeds even if reopen fails (best-effort)", async () => {
    const outcomeRow = {
      id: "out-revert-4",
      companyId: "co-r",
      kind: "artifact_declared",
      status: "verified",
      targetKind: "issue",
      targetId: "iss-r-4",
      requiredMeta: { name: "patch", artifact_kind: "code.patch", auto_reopen_on_revert: true },
      revertedAt: null,
      revertedReason: null,
    };
    const db = makeMultiTableFakeDbSvc({ outcomes: [outcomeRow], issues: [] });

    // Intercept update so that the issues table update rejects (simulates a DB failure in the
    // parent-reopen path). The outcomes update must still use .returning() per revertOutcome.
    const origUpdate = db.update.bind(db);
    db.update = (table: any) => {
      const tableName: string =
        table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
      if (tableName === "issues") {
        // Return a thenable that rejects immediately.
        return {
          set(_values: any) {
            return {
              where(_condition: any) {
                return {
                  then(resolve: any, reject: any) {
                    reject(new Error("db failure in parent update"));
                  },
                  returning(): Promise<any[]> {
                    return Promise.reject(new Error("db failure in parent update"));
                  },
                };
              },
            };
          },
        };
      }
      return origUpdate(table);
    };

    const svc = initializeOutcomesService({ db: db as any });
    const result = await svc.revertOutcome("out-revert-4", "test-reason");

    // Revert itself succeeded
    expect(result.id).toBe("out-revert-4");
    expect(result.parentReopened).toBe(false);
    // The reverted row itself has status reverted
    expect(db.allRows["outcomes"][0].status).toBe("reverted");
  });
});

// ---------------------------------------------------------------------------
// OutcomesService.applyPlaybookToIssue (EO-P2-12)
// ---------------------------------------------------------------------------
//
// applyPlaybookToIssue accepts an optional `applicabilityScore` param so tests
// can drive the score directly without needing a live DB + playbook row for
// matchPlaybookApplicability. When passed, the service skips the DB-based
// applicability lookup and uses the supplied score instead.
// (Documented as DONE_WITH_CONCERNS if the real applicability gate matters; see report.)

describe("OutcomesService.applyPlaybookToIssue", () => {
  // Build a fakeDb that supports issues + outcomes + playbooks tables with
  // per-table routing, plus the full materializeContract transaction plumbing.
  function makeApplyDb(opts: {
    issueRow: Record<string, unknown>;
    playbookRow: Record<string, unknown>;
    existingOutcomes?: any[];
  }) {
    const store: Record<string, any[]> = {
      issues: [{ ...opts.issueRow }],
      playbooks: [{ ...opts.playbookRow }],
      outcomes: (opts.existingOutcomes ?? []).map((r) => ({ ...r })),
    };

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
        return chunk !== null && typeof chunk === "object" && typeof chunk.name === "string" && "keyAsName" in chunk;
      }
      function walk(chunks: any[]) {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk || typeof chunk !== "object") continue;
          if (isColumnNode(chunk)) {
            const val = resolveValue(chunks[i + 2]);
            if (val !== undefined) pairs[chunk.name] = val;
            continue;
          }
          if (Array.isArray(chunk.queryChunks)) walk(chunk.queryChunks);
        }
      }
      if (Array.isArray(condition.queryChunks)) walk(condition.queryChunks);
      return pairs;
    }

    const db: any = {
      allRows: store,

      select(_projection?: any) {
        return {
          from(table: any) {
            const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
            return {
              where(condition: any): Promise<any[]> {
                const rows: any[] = store[tableName] ?? [];
                const filters = extractEqs(condition);
                return Promise.resolve(
                  rows.filter((row) =>
                    Object.entries(filters).every(([k, v]) => {
                      const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
                      return row[camel] === v || row[k] === v;
                    }),
                  ),
                );
              },
            };
          },
        };
      },

      update(table: any) {
        const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
        return {
          set(values: any) {
            return {
              where(condition: any) {
                const applyUpdate = (): any[] => {
                  const rows: any[] = store[tableName] ?? [];
                  const filters = extractEqs(condition);
                  const matched = rows.filter((row) =>
                    Object.entries(filters).every(([k, v]) => {
                      const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
                      return row[camel] === v || row[k] === v;
                    }),
                  );
                  for (const row of matched) Object.assign(row, values);
                  return matched;
                };
                return {
                  then(resolve: any, reject: any) {
                    try { resolve(applyUpdate()); } catch (e) { reject(e); }
                  },
                  returning(): Promise<any[]> {
                    return Promise.resolve(applyUpdate());
                  },
                };
              },
            };
          },
        };
      },

      transaction: async (fn: any) => fn(db),
    };

    // Add insert support on the db object too (for materializeContract)
    db.insert = (table: any) => {
      const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
      return {
        values(v: any) {
          const row = { ...v, id: `id-${(store[tableName] ?? []).length}` };
          (store[tableName] = store[tableName] ?? []).push(row);
          return { returning: async () => [row] };
        },
      };
    };

    db.delete = (table: any) => {
      const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
      return {
        where(condition: any) {
          const rows: any[] = store[tableName] ?? [];
          const filters = extractEqs(condition);
          const idx = rows.findIndex((row) =>
            Object.entries(filters).every(([k, v]) => {
              const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
              return row[camel] === v || row[k] === v;
            }),
          );
          if (idx !== -1) rows.splice(idx, 1);
          return Promise.resolve();
        },
      };
    };

    return db;
  }

  const COMPANY_ID = "co-apply-1";
  const ISSUE_ID = "iss-apply-1";
  const PLAYBOOK_ID = "pb-apply-1";

  it("merges suggested_outcomes into issue.requiredOutcomes with skip_existing", async () => {
    const existingOutcome = {
      id: "out-existing-1",
      companyId: COMPANY_ID,
      targetKind: "issue",
      targetId: ISSUE_ID,
      kind: "artifact_declared",
      status: "pending",
      requiredMeta: { name: "patch", artifact_kind: "code.patch" },
    };
    const issueRow = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      requiredOutcomes: [
        { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
      ],
    };
    const playbookRow = {
      id: PLAYBOOK_ID,
      companyId: COMPANY_ID,
      suggestedOutcomes: [
        { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
        { kind: "artifact_declared", requiredMeta: { name: "spec", artifact_kind: "doc.markdown" } },
      ],
    };

    const db = makeApplyDb({ issueRow, playbookRow, existingOutcomes: [existingOutcome] });
    const svc = initializeOutcomesService({ db });

    const result = await svc.applyPlaybookToIssue(
      { callerCompanyId: COMPANY_ID },
      ISSUE_ID,
      PLAYBOOK_ID,
      "skip_existing",
      1, // applicabilityScore override
    );

    expect(result.addedOutcomes).toHaveLength(1);
    expect(result.addedOutcomes[0].name).toBe("spec");
    expect(result.skippedExisting).toHaveLength(1);
    expect(result.skippedExisting[0].name).toBe("patch");
    expect(result.newContractLength).toBe(2); // 1 existing + 1 new
  });

  it("replace strategy drops existing pending rows and reapplies", async () => {
    const existingOutcome = {
      id: "out-existing-2",
      companyId: COMPANY_ID,
      targetKind: "issue",
      targetId: ISSUE_ID,
      kind: "artifact_declared",
      status: "pending",
      requiredMeta: { name: "patch", artifact_kind: "code.patch" },
    };
    const issueRow = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      requiredOutcomes: [
        { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
      ],
    };
    const playbookRow = {
      id: PLAYBOOK_ID,
      companyId: COMPANY_ID,
      suggestedOutcomes: [
        { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
        { kind: "artifact_declared", requiredMeta: { name: "spec", artifact_kind: "doc.markdown" } },
      ],
    };

    const db = makeApplyDb({ issueRow, playbookRow, existingOutcomes: [existingOutcome] });
    const svc = initializeOutcomesService({ db });

    const result = await svc.applyPlaybookToIssue(
      { callerCompanyId: COMPANY_ID },
      ISSUE_ID,
      PLAYBOOK_ID,
      "replace",
      1, // applicabilityScore override
    );

    // replace: merged = suggested array only (2 entries), skipped = 0
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.newContractLength).toBe(2);
    // both entries are "added" in replace mode
    expect(result.addedOutcomes).toHaveLength(2);
  });

  it("throws PlaybookNotApplicableError when applicability score is 0", async () => {
    const issueRow = { id: ISSUE_ID, companyId: COMPANY_ID, requiredOutcomes: [] };
    const playbookRow = {
      id: PLAYBOOK_ID,
      companyId: COMPANY_ID,
      suggestedOutcomes: [
        { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
      ],
    };
    const db = makeApplyDb({ issueRow, playbookRow });
    const svc = initializeOutcomesService({ db });

    await expect(
      svc.applyPlaybookToIssue(
        { callerCompanyId: COMPANY_ID },
        ISSUE_ID,
        PLAYBOOK_ID,
        "skip_existing",
        0, // score = 0 → not applicable
      ),
    ).rejects.toThrow(PlaybookNotApplicableError);
  });
});
