import { describe, expect, it, beforeEach } from "vitest";
import { initializeOutcomesService, getOutcomesService } from "../service.js";
import { OutcomeRequiredError } from "../types.js";

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
