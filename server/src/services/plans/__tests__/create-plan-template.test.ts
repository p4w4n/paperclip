// Tests for EO-P2-9: PlanService.createPlan with optional templateId.
//
// Uses the same vi.mock approach as plan-gate.test.ts so we can control
// getPlanTemplateService and getOutcomesService without a live database.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { PlanTemplateNotFoundError } from "../service.js";

// ── mock template service singleton ──────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetById = vi.hoisted(() => vi.fn<any>());

vi.mock("../../templates/service.js", () => ({
  getPlanTemplateService: () => ({ getById: mockGetById }),
  PlanTemplateNotFoundError: class PlanTemplateNotFoundError extends Error {
    statusCode = 404;
    constructor(id: string) {
      super(`Plan template not found: ${id}`);
      this.name = "PlanTemplateNotFoundError";
    }
  },
}));

// ── mock outcomes service singleton ──────────────────────────────────────────
const mockMaterializeContract = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: 0, kept: 0, pendingDeleted: 0, droppedVerified: 0 })),
);

vi.mock("../../outcomes/service.js", () => ({
  getOutcomesService: () => ({ materializeContract: mockMaterializeContract }),
}));

// ── minimal fakeDb matching the pattern in service.test.ts ───────────────────
function makeFakeDb() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    insert: vi.fn((tbl: { _?: { name: string } }) => ({
      values: vi.fn((v: Record<string, unknown>) => {
        const arr = Array.isArray(v) ? v : [v];
        for (const x of arr)
          inserts.push({ table: tbl?._?.name ?? "unknown", values: x });
        return {
          returning: vi.fn(async () =>
            arr.map((x, idx) => ({
              ...x,
              id: `inserted-${inserts.length}-${idx}`,
              currentRevisionNumber: 0,
              currentRevisionId: null,
              status: "draft",
              approvalPolicy: "one_human",
              phaseAdvancePolicy: "auto",
              issueId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              approvedAt: null,
              completedAt: null,
            })),
          ),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        updates.push({ values: v });
        return { where: vi.fn(async () => {}) };
      }),
    })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => {}) })),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    insert: tx.insert,
    update: tx.update,
    delete: tx.delete,
  };

  return { db, inserts, updates };
}

// Import *after* mocks are registered so the singleton calls resolve correctly.
const { createPlanService } = await import("../service.js");

const ctx = { callerCompanyId: "co-1" };
const baseInput = { companyId: "co-1", title: "My Plan", initialContent: "## Plan" };

describe("PlanService.createPlan { templateId }", () => {
  beforeEach(() => {
    mockGetById.mockReset();
    mockMaterializeContract.mockReset();
    mockMaterializeContract.mockResolvedValue({
      inserted: 0,
      kept: 0,
      pendingDeleted: 0,
      droppedVerified: 0,
    });
  });

  it("throws PlanTemplateNotFoundError on missing template (getById returns null)", async () => {
    mockGetById.mockResolvedValue(null);

    const { db } = makeFakeDb();
    const svc = createPlanService({ db });

    await expect(
      svc.createPlan(ctx, { ...baseInput, templateId: "tmpl-nonexistent" }),
    ).rejects.toBeInstanceOf(PlanTemplateNotFoundError);

    // No plan row should have been inserted — the tx insert spy tracks inserts.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("treats archived templates as missing — getById returns null, createPlan throws", async () => {
    // PlanTemplateService.getById returns null for archived templates already
    // (tested in templates/service tests). Here we just verify the plan service
    // propagates the null → error correctly.
    mockGetById.mockResolvedValue(null);

    const { db } = makeFakeDb();
    const svc = createPlanService({ db });

    await expect(
      svc.createPlan(ctx, { ...baseInput, templateId: "tmpl-archived" }),
    ).rejects.toBeInstanceOf(PlanTemplateNotFoundError);
  });

  it("materializes the template contract + persists plans.requiredOutcomes", async () => {
    const fakeTemplate = {
      id: "tmpl-1",
      companyId: "co-1",
      name: "Standard",
      defaultRequiredOutcomes: [
        { kind: "manual_signoff", requiredMeta: { name: "ack" } },
      ],
    };
    mockGetById.mockResolvedValue(fakeTemplate);
    mockMaterializeContract.mockResolvedValue({
      inserted: 1,
      kept: 0,
      pendingDeleted: 0,
      droppedVerified: 0,
    });

    const { db, updates } = makeFakeDb();
    const svc = createPlanService({ db });

    const plan = await svc.createPlan(ctx, {
      ...baseInput,
      templateId: "tmpl-1",
    });

    // The plan row should have been returned.
    expect(plan).toBeDefined();
    expect(plan.companyId).toBe("co-1");

    // requiredOutcomes update should have been called inside the transaction.
    const outcomeUpdate = updates.find(
      (u) => Array.isArray(u.values.requiredOutcomes),
    );
    expect(outcomeUpdate).toBeDefined();
    expect(outcomeUpdate?.values.requiredOutcomes).toEqual([
      { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    ]);

    // materializeContract should have been called after the transaction.
    expect(mockMaterializeContract).toHaveBeenCalledOnce();
    expect(mockMaterializeContract).toHaveBeenCalledWith(
      { kind: "plan", id: plan.id, companyId: "co-1" },
      [{ kind: "manual_signoff", requiredMeta: { name: "ack" } }],
    );
  });

  it("skips contract materialization when no templateId is provided", async () => {
    const { db } = makeFakeDb();
    const svc = createPlanService({ db });

    await svc.createPlan(ctx, baseInput);

    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockMaterializeContract).not.toHaveBeenCalled();
  });
});
