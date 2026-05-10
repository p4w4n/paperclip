import { describe, expect, it } from "vitest";
import { allOutcomesVerified } from "../predicate.js";
import { OutcomeRequiredError } from "../types.js";

describe("allOutcomesVerified", () => {
  it("returns true when no pending rows exist for the target", async () => {
    let queryCount = 0;
    const db = {
      select: () => ({ from: () => ({ where: async () => {
        queryCount++;
        return queryCount === 1 ? [{ count: 0 }] : [];
      }}) }),
    } as any;
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBe(true);
  });

  it("returns OutcomeRequiredError when any pending rows exist", async () => {
    let queryCount = 0;
    const db = {
      select: () => ({ from: () => ({ where: async () => {
        queryCount++;
        return queryCount === 1
          ? [{ count: 1 }]
          : [{ id: "o1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" }];
      }}) }),
    } as any;
    const r = await allOutcomesVerified(db, { kind: "issue", id: "i1", companyId: "c1" });
    expect(r).toBeInstanceOf(OutcomeRequiredError);
    if (r instanceof OutcomeRequiredError) {
      expect(r.body.pending).toHaveLength(1);
    }
  });
});
