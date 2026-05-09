import { describe, expect, it, vi } from "vitest";
import { createOrgLearningService } from "../service.js";
import { LearningTenantMismatchError } from "../types.js";

function fakeDb({ pbRow }: { pbRow?: Record<string, unknown> | null } = {}) {
  const inserts: Array<{ values: Record<string, unknown> }> = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  let txInsertCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        const arr = Array.isArray(v) ? v : [v];
        for (const x of arr) inserts.push({ values: x });
        return {
          returning: vi.fn(async () =>
            arr.map((x, idx) => ({
              ...x,
              id: `inserted-${++txInsertCount}-${idx}`,
              currentRevisionNumber: 1,
              status: x.status ?? "proposed",
              currentRevisionId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              archivedAt: null,
              approvedAt: null,
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
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => (pbRow ? [pbRow] : [])),
      })),
    })),
    insert: tx.insert,
    update: tx.update,
  };
  return { db, inserts, updates };
}

describe("OrgLearningService.createPlaybook", () => {
  it("rejects cross-company calls", async () => {
    const { db } = fakeDb();
    const svc = createOrgLearningService({ db });
    await expect(
      svc.createPlaybook(
        { callerCompanyId: "co-A" },
        {
          companyId: "co-B",
          title: "x",
          slug: "x",
          contentMarkdown: "body",
        },
      ),
    ).rejects.toBeInstanceOf(LearningTenantMismatchError);
  });

  it("inserts playbook + initial revision in one tx", async () => {
    const { db, inserts, updates } = fakeDb();
    const svc = createOrgLearningService({ db });
    const pb = await svc.createPlaybook(
      { callerCompanyId: "co-1" },
      {
        companyId: "co-1",
        title: "Deploy",
        slug: "deploy",
        contentMarkdown: "## Steps",
      },
    );
    expect(pb.title).toBe("Deploy");
    // 2 inserts (playbook + revision) + 1 update (currentRevisionId).
    expect(inserts.length).toBe(2);
    expect(updates.length).toBe(1);
  });
});

describe("OrgLearningService.approvePlaybook", () => {
  it("transitions status to active", async () => {
    const { db, updates } = fakeDb({
      pbRow: { id: "pb-1", companyId: "co-1", status: "proposed", currentRevisionNumber: 1, agentId: null, slug: "x" },
    });
    const svc = createOrgLearningService({ db });
    await svc.approvePlaybook({ callerCompanyId: "co-1" }, "pb-1");
    expect(updates[0].values.status).toBe("active");
    expect(updates[0].values.approvedAt).toBeInstanceOf(Date);
  });
});
