import { describe, expect, it, vi } from "vitest";
import { createPlanService } from "../service.js";
import { PlanTenantMismatchError } from "../types.js";

function makeChain<T>(value: T) {
  return Promise.resolve(value);
}

function fakeDb({
  planRow,
  phaseRow,
  depRows = [],
  remainingPhases = [],
}: {
  planRow?: Record<string, unknown> | null;
  phaseRow?: Record<string, unknown> | null;
  depRows?: Array<{ fromPhaseId: string }>;
  remainingPhases?: Array<{ id: string }>;
}) {
  const inserts: Array<{ values: Record<string, unknown> }> = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  let selectCall = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => makeChain(remainingPhases)),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        const arr = Array.isArray(v) ? v : [v];
        for (const x of arr) inserts.push({ values: x });
        return {
          returning: vi.fn(async () =>
            arr.map((x, idx) => ({
              ...x,
              id: `inserted-${inserts.length}-${idx}`,
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
    delete: vi.fn(() => ({ where: vi.fn(async () => {}) })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    select: vi.fn(() => ({
      from: vi.fn((tbl) => ({
        where: vi.fn(() => {
          selectCall++;
          // First top-level select hits plans/phases lookup; use
          // the planRow / phaseRow inputs.
          const tableName = (tbl as { _: { name: string } } | undefined)?._?.name;
          if (tableName === "plans") return makeChain(planRow ? [planRow] : []);
          if (tableName === "plan_phases" && selectCall === 1)
            return makeChain(phaseRow ? [phaseRow] : []);
          if (tableName === "plan_phase_dependencies") return makeChain(depRows);
          return makeChain(planRow ? [planRow] : []);
        }),
      })),
    })),
    insert: tx.insert,
    update: tx.update,
    delete: tx.delete,
  };
  return { db, inserts, updates };
}

const onPlanCompleted = vi.fn();

describe("PlanService.createPlan", () => {
  it("rejects cross-company calls", async () => {
    const { db } = fakeDb({});
    const svc = createPlanService({ db, onPlanCompleted });
    await expect(
      svc.createPlan(
        { callerCompanyId: "co-A" },
        { companyId: "co-B", title: "x", initialContent: "hello" },
      ),
    ).rejects.toBeInstanceOf(PlanTenantMismatchError);
  });

  it("inserts plan + initial revision + phases + deps", async () => {
    const { db, inserts } = fakeDb({});
    const svc = createPlanService({ db, onPlanCompleted });
    await svc.createPlan(
      { callerCompanyId: "co-1" },
      {
        companyId: "co-1",
        title: "auth refactor",
        initialContent: "## Plan",
        phases: [
          { name: "Research" },
          { name: "Design", dependsOnOrdering: [1] },
          { name: "Implement", dependsOnOrdering: [2] },
        ],
      },
    );
    // plans + revisions + phases (3) + deps (2) ≥ 6 inserts.
    expect(inserts.length).toBeGreaterThanOrEqual(6);
  });

  it("rejects a phase DAG that creates a cycle", async () => {
    const { db } = fakeDb({});
    const svc = createPlanService({ db, onPlanCompleted });
    await expect(
      svc.createPlan(
        { callerCompanyId: "co-1" },
        {
          companyId: "co-1",
          title: "x",
          initialContent: "x",
          phases: [
            { name: "A", dependsOnOrdering: [2] },
            { name: "B", dependsOnOrdering: [1] },
          ],
        },
      ),
    ).rejects.toThrow(/cycle/);
  });
});

describe("PlanService.recordDecision", () => {
  it("inserts a decision row with the right shape", async () => {
    const { db, inserts } = fakeDb({
      planRow: {
        id: "p-1",
        companyId: "co-1",
        currentRevisionNumber: 1,
        currentRevisionId: "r-1",
        status: "in_progress",
        approvalPolicy: "one_human",
        phaseAdvancePolicy: "auto",
        title: "x",
        issueId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        approvedAt: new Date(),
        completedAt: null,
      },
    });
    const svc = createPlanService({ db, onPlanCompleted });
    await svc.recordDecision(
      { callerCompanyId: "co-1" },
      "p-1",
      {
        title: "DB choice",
        options: [
          { id: "pg", label: "Postgres" },
          { id: "my", label: "MySQL" },
        ],
        chosenOptionId: "pg",
        rationaleMarkdown: "we already use it",
      },
    );
    const found = inserts.find((i) => i.values.title === "DB choice");
    expect(found?.values.chosenOptionId).toBe("pg");
  });
});
