import { describe, expect, it, beforeEach } from "vitest";
import { initializeOutcomesService } from "../service.js";
import { verifyApprovalGranted } from "../verifiers/approval-granted.js";
import { verifyExitCriteriaMet } from "../verifiers/exit-criteria-met.js";

// ---------------------------------------------------------------------------
// fakeDb that supports:
//   db.select().from(table).where(and(eq(...), eq(...), eq(...)))  → array
//   db.update(table).set({...}).where(and(eq(...), eq(...))).returning() → array
//
// Each call resolves predicates by inspecting Drizzle's internal SQL structure.
// We walk the `and(...)` node (or single eq) and collect {column, value} pairs,
// then filter / mutate rows accordingly.
// ---------------------------------------------------------------------------

/**
 * Extract { columnName: value } pairs from a drizzle `and(eq(...), ...)` node.
 *
 * Drizzle stores everything as queryChunks trees. An eq() produces:
 *   [ {value:[""]}, colNode, {value:[" = "]}, paramNode, {value:[""]} ]
 * where:
 *   colNode  = { name: "col_name", keyAsName: bool, … }   (the column descriptor)
 *   paramNode = { brand: undefined, value: "actual_val", encoder: … }  (the bound param)
 *
 * We walk the whole tree looking for column nodes followed 2 positions later
 * by a param node (with a `.value` scalar), which is the bound value.
 */
function extractEqs(condition: any): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};
  if (!condition) return pairs;

  function resolveValue(v: any): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    // Drizzle param node: { brand, value, encoder }
    if (typeof v === "object" && "value" in v) return v.value;
    return undefined;
  }

  function isColumnNode(chunk: any): boolean {
    return (
      chunk !== null &&
      typeof chunk === "object" &&
      typeof chunk.name === "string" &&
      "keyAsName" in chunk  // presence of keyAsName is specific to drizzle column descriptors
    );
  }

  function walk(chunks: any[]) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || typeof chunk !== "object") continue;

      if (isColumnNode(chunk)) {
        // Layout: col at i, " = " fragment at i+1, param at i+2
        const paramNode = chunks[i + 2];
        const val = resolveValue(paramNode);
        if (val !== undefined) {
          pairs[chunk.name] = val;
        }
        continue;
      }

      // Recurse into queryChunks
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

/** Very simple in-memory row store with Drizzle-shaped query builder. */
function makeFakeDb(initialRows: any[] = []) {
  const rows: any[] = initialRows.map((r) => ({ ...r }));

  function filterRows(condition: any): any[] {
    const filters = extractEqs(condition);
    return rows.filter((row) =>
      Object.entries(filters).every(([k, v]) => {
        // Map drizzle snake_case column name to camelCase row key.
        const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
        return row[camel] === v || row[k] === v;
      }),
    );
  }

  const db = {
    rows,

    select() {
      return {
        from(_table: any) {
          return {
            where(condition: any): Promise<any[]> {
              return Promise.resolve(filterRows(condition));
            },
          };
        },
      };
    },

    update(_table: any) {
      return {
        set(values: any) {
          return {
            where(condition: any) {
              return {
                returning(): Promise<any[]> {
                  const matched = filterRows(condition);
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

    // transaction not used by verifier tests, but included for completeness
    transaction: async (fn: any) => fn(db),
  };

  return db;
}

/**
 * A two-table fakeDb for verifiers that perform selects on multiple tables
 * (e.g. approval-granted: issueApprovals + outcomes).
 * `tableRows` maps a table's name to its row array.
 */
function makeMultiTableFakeDb(tableRows: Record<string, any[]>) {
  // Mutable copies of each table's rows.
  const store: Record<string, any[]> = {};
  for (const [k, rows] of Object.entries(tableRows)) {
    store[k] = rows.map((r) => ({ ...r }));
  }

  // Expose the underlying row arrays for assertion in tests.
  const allRows = store;

  const db = {
    allRows,

    select(_projection?: any) {
      return {
        from(table: any) {
          const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
          return {
            where(condition: any): Promise<any[]> {
              const rows: any[] = store[tableName] ?? [];
              const filters = extractEqs(condition);
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
      const tableName: string = table[Symbol.for("drizzle:Name")] ?? table._.name ?? table.name ?? "";
      return {
        set(values: any) {
          return {
            where(condition: any) {
              return {
                returning(): Promise<any[]> {
                  const rows: any[] = store[tableName] ?? [];
                  const filters = extractEqs(condition);
                  const matched = rows.filter((row) =>
                    Object.entries(filters).every(([k, v]) => {
                      const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
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
// Test data helpers
// ---------------------------------------------------------------------------

function pendingArtifactDeclaredOutcome(overrides: Partial<any> = {}): any {
  return {
    id: "out-1",
    companyId: "co-1",
    targetKind: "issue",
    targetId: "i1",
    kind: "artifact_declared",
    status: "pending",
    requiredMeta: {
      artifact_kind: "code.patch",
      name: "patch",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifier — artifact_declared", () => {
  let svc: ReturnType<typeof initializeOutcomesService>;

  it("flips matching pending outcome to verified when artifact name + kind match", async () => {
    const row = pendingArtifactDeclaredOutcome();
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("artifact_declared", {
      id: "art-1",
      companyId: "co-1",
      issueId: "i1",
      kind: "code.patch",
      name: "patch",
      blobSha256: "abc123",
      declaredAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
    expect(db.rows[0].verifiedMeta).toMatchObject({ artifact_id: "art-1" });
  });

  it("ignores artifact whose issue_id doesn't match the outcome target", async () => {
    const row = pendingArtifactDeclaredOutcome(); // targetId = 'i1'
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("artifact_declared", {
      id: "art-2",
      companyId: "co-1",
      issueId: "i99", // different issue
      kind: "code.patch",
      name: "patch",
      blobSha256: "abc123",
      declaredAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(0);
    expect(db.rows[0].status).toBe("pending");
  });

  it("respects name_glob when present — '*.diff' matches 'patch.diff'", async () => {
    const row = pendingArtifactDeclaredOutcome({
      requiredMeta: {
        artifact_kind: "code.patch",
        name: "patch", // would not match exact, but glob overrides
        name_glob: "*.diff",
      },
    });
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("artifact_declared", {
      id: "art-3",
      companyId: "co-1",
      issueId: "i1",
      kind: "code.patch",
      name: "patch.diff",
      blobSha256: "abc123",
      declaredAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
  });

  it("is idempotent: a second firing for the already-verified outcome is a no-op", async () => {
    const row = pendingArtifactDeclaredOutcome({ status: "verified" });
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    // Fire with correct evidence — but row is already verified, so select()
    // won't find it (status !== 'pending') and verifiedCount must be 0.
    const result = await svc.tryVerify("artifact_declared", {
      id: "art-1",
      companyId: "co-1",
      issueId: "i1",
      kind: "code.patch",
      name: "patch",
      blobSha256: "abc123",
      declaredAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// plan_completed helper
// ---------------------------------------------------------------------------

function pendingPlanCompletedOutcome(overrides: Partial<any> = {}): any {
  return {
    id: "out-pc-1",
    companyId: "co-1",
    targetKind: "issue",
    targetId: "i1",
    kind: "plan_completed",
    status: "pending",
    requiredMeta: {},
    ...overrides,
  };
}

describe("verifier — plan_completed", () => {
  let svc: ReturnType<typeof initializeOutcomesService>;

  it("flips outcome (target=issue, no plan_id) when any plan tagged on the issue completes", async () => {
    const row = pendingPlanCompletedOutcome();
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("plan_completed", {
      planId: "plan-1",
      companyId: "co-1",
      issueId: "i1",
      completedAt: new Date("2026-02-01T00:00:00Z"),
      revisionId: "rev-1",
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
    expect(db.rows[0].verifiedMeta).toMatchObject({ plan_id: "plan-1" });
  });

  it("flips outcome (target=plan) only when target_id matches the planId in evidence", async () => {
    const row = pendingPlanCompletedOutcome({ targetKind: "plan", targetId: "plan-2" });
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    // Wrong plan — should not flip
    const miss = await svc.tryVerify("plan_completed", {
      planId: "plan-1",
      companyId: "co-1",
      issueId: "i1",
      completedAt: new Date("2026-02-01T00:00:00Z"),
      revisionId: null,
    });
    expect(miss.verifiedCount).toBe(0);
    expect(db.rows[0].status).toBe("pending");

    // Correct plan — should flip
    const hit = await svc.tryVerify("plan_completed", {
      planId: "plan-2",
      companyId: "co-1",
      issueId: "i1",
      completedAt: new Date("2026-02-01T00:00:00Z"),
      revisionId: null,
    });
    expect(hit.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
  });

  it("flips outcome with explicit plan_id only when that plan_id matches", async () => {
    const row = pendingPlanCompletedOutcome({
      requiredMeta: { plan_id: "plan-specific" },
    });
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    // Different plan — should not flip even though issue matches
    const miss = await svc.tryVerify("plan_completed", {
      planId: "plan-other",
      companyId: "co-1",
      issueId: "i1",
      completedAt: new Date("2026-02-01T00:00:00Z"),
      revisionId: null,
    });
    expect(miss.verifiedCount).toBe(0);

    // Exact plan_id match — should flip
    const hit = await svc.tryVerify("plan_completed", {
      planId: "plan-specific",
      companyId: "co-1",
      issueId: "i1",
      completedAt: new Date("2026-02-01T00:00:00Z"),
      revisionId: null,
    });
    expect(hit.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// decision_recorded helper
// ---------------------------------------------------------------------------

function pendingDecisionRecordedOutcome(overrides: Partial<any> = {}): any {
  return {
    id: "out-dr-1",
    companyId: "co-1",
    targetKind: "plan",
    targetId: "plan-1",
    kind: "decision_recorded",
    status: "pending",
    requiredMeta: {
      plan_id: "plan-1",
      decision_title: "Choose deployment strategy",
    },
    ...overrides,
  };
}

describe("verifier — decision_recorded", () => {
  let svc: ReturnType<typeof initializeOutcomesService>;

  it("flips when a plan_decisions row with chosen_option_id and matching title is inserted", async () => {
    const row = pendingDecisionRecordedOutcome();
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("decision_recorded", {
      decisionId: "dec-1",
      companyId: "co-1",
      planId: "plan-1",
      planIssueId: "i1",
      title: "Choose deployment strategy",
      chosenOptionId: "opt-blue",
      decidedAt: new Date("2026-03-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
    expect(db.rows[0].verifiedMeta).toMatchObject({
      decision_id: "dec-1",
      chosen_option_id: "opt-blue",
    });
  });

  it("does not flip when chosen_option_id is null", async () => {
    const row = pendingDecisionRecordedOutcome();
    const db = makeFakeDb([row]);
    svc = initializeOutcomesService({ db } as any);

    const result = await svc.tryVerify("decision_recorded", {
      decisionId: "dec-1",
      companyId: "co-1",
      planId: "plan-1",
      planIssueId: "i1",
      title: "Choose deployment strategy",
      chosenOptionId: null,
      decidedAt: new Date("2026-03-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(0);
    expect(db.rows[0].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// approval_granted tests
// ---------------------------------------------------------------------------

function pendingApprovalGrantedOutcome(overrides: Partial<any> = {}): any {
  return {
    id: "out-ag-1",
    companyId: "co-1",
    targetKind: "issue",
    targetId: "i1",
    kind: "approval_granted",
    status: "pending",
    requiredMeta: {
      approval_kind: "legal",
    },
    ...overrides,
  };
}

describe("verifier — approval_granted", () => {
  it("flips when approvals.status='approved' and approval_kind matches and the issue link exists in issue_approvals", async () => {
    const outcomeRow = pendingApprovalGrantedOutcome();
    const approvalLinkRow = { approvalId: "appr-1", issueId: "i1" };
    const db = makeMultiTableFakeDb({
      issue_approvals: [approvalLinkRow],
      outcomes: [outcomeRow],
    });

    const result = await verifyApprovalGranted(db as any, {
      approvalId: "appr-1",
      companyId: "co-1",
      approvalKind: "legal",
      decidedByUserId: "user-1",
      decidedAt: new Date("2026-04-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.allRows["outcomes"][0].status).toBe("verified");
    expect(db.allRows["outcomes"][0].verifiedMeta).toMatchObject({
      approval_id: "appr-1",
      decided_by_user_id: "user-1",
    });
  });

  it("ignores approval whose kind doesn't match required_meta.approval_kind", async () => {
    const outcomeRow = pendingApprovalGrantedOutcome(); // approval_kind: "legal"
    const approvalLinkRow = { approvalId: "appr-2", issueId: "i1" };
    const db = makeMultiTableFakeDb({
      issue_approvals: [approvalLinkRow],
      outcomes: [outcomeRow],
    });

    const result = await verifyApprovalGranted(db as any, {
      approvalId: "appr-2",
      companyId: "co-1",
      approvalKind: "financial", // different kind
      decidedByUserId: null,
      decidedAt: new Date("2026-04-01T00:00:00Z"),
    });

    expect(result.verifiedCount).toBe(0);
    expect(db.allRows["outcomes"][0].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// exit_criteria_met tests
// ---------------------------------------------------------------------------

function pendingExitCriteriaMetOutcome(overrides: Partial<any> = {}): any {
  return {
    id: "out-ec-1",
    companyId: "co-1",
    targetKind: "issue",
    targetId: "issue-plan-1",
    kind: "exit_criteria_met",
    status: "pending",
    requiredMeta: {
      plan_phase_id: "phase-1",
    },
    ...overrides,
  };
}

describe("verifier — exit_criteria_met", () => {
  it("flips when phase exit_criteria_markdown has all checkboxes checked", async () => {
    const outcomeRow = pendingExitCriteriaMetOutcome();
    const db = makeFakeDb([outcomeRow]);

    const result = await verifyExitCriteriaMet(db as any, {
      planPhaseId: "phase-1",
      companyId: "co-1",
      planId: "plan-1",
      planIssueId: "issue-plan-1",
      exitCriteriaMarkdown: "- [x] one\n- [x] two",
    });

    expect(result.verifiedCount).toBe(1);
    expect(db.rows[0].status).toBe("verified");
    expect(db.rows[0].verifiedMeta).toMatchObject({ checked_count: 2, total_count: 2 });
  });

  it("does not flip when any checkbox is unchecked", async () => {
    const outcomeRow = pendingExitCriteriaMetOutcome();
    const db = makeFakeDb([outcomeRow]);

    const result = await verifyExitCriteriaMet(db as any, {
      planPhaseId: "phase-1",
      companyId: "co-1",
      planId: "plan-1",
      planIssueId: "issue-plan-1",
      exitCriteriaMarkdown: "- [x] a\n- [ ] b",
    });

    expect(result.verifiedCount).toBe(0);
    expect(db.rows[0].status).toBe("pending");
  });
});
