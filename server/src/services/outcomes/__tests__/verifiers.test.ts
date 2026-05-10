import { describe, expect, it, beforeEach } from "vitest";
import { initializeOutcomesService } from "../service.js";

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
