import { describe, expect, it } from "vitest";
import { allOutcomesVerified } from "../predicate.js";
import { OutcomeRequiredError } from "../types.js";

// Builds a simple fakeDb that returns the given rows for any .select().from().where() call.
function makeFakeDb(rows: any[]) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as any;
}

describe("allOutcomesVerified", () => {
  it("returns true when no rows exist for the target", async () => {
    const db = makeFakeDb([]);
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBe(true);
  });

  it("returns OutcomeRequiredError when any pending rows exist", async () => {
    const db = makeFakeDb([
      { id: "o1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" },
    ]);
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBeInstanceOf(OutcomeRequiredError);
    if (r instanceof OutcomeRequiredError) {
      expect(r.body.pending).toHaveLength(1);
    }
  });
});

describe("allOutcomesVerified — alias awareness", () => {
  it("a slot satisfied by an alternative does not block the gate", async () => {
    // ci is pending but ci:alt:0 is verified — slot is satisfied.
    const db = makeFakeDb([
      { id: "o1", kind: "ci", requiredMeta: { name: "ci" }, status: "pending" },
      { id: "o2", kind: "ci", requiredMeta: { name: "ci:alt:0" }, status: "verified" },
    ]);
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBe(true);
  });

  it("a slot with NO verified row blocks the gate", async () => {
    // Both ci and ci:alt:0 are pending — slot is NOT satisfied.
    const db = makeFakeDb([
      { id: "o1", kind: "ci", requiredMeta: { name: "ci" }, status: "pending" },
      { id: "o2", kind: "ci", requiredMeta: { name: "ci:alt:0" }, status: "pending" },
    ]);
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBeInstanceOf(OutcomeRequiredError);
  });

  it("the error body groups alias siblings under one entry", async () => {
    // ci (pending) + ci:alt:0 (pending) + ack (pending) — two distinct slots.
    const db = makeFakeDb([
      { id: "o1", kind: "ci", requiredMeta: { name: "ci" }, status: "pending" },
      { id: "o2", kind: "ci", requiredMeta: { name: "ci:alt:0" }, status: "pending" },
      { id: "o3", kind: "manual_signoff", requiredMeta: { name: "ack" }, status: "pending" },
    ]);
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBeInstanceOf(OutcomeRequiredError);
    if (r instanceof OutcomeRequiredError) {
      // Two slots (ci and ack), not 3 rows.
      expect(r.body.pending).toHaveLength(2);
      // The blocking ci entry should surface the primary row (name === "ci").
      const ciEntry = r.body.pending.find((p: any) => p.required_meta?.name === "ci");
      expect(ciEntry).toBeDefined();
    }
  });
});
