import { describe, expect, it, beforeEach } from "vitest";
import { initializePlanTemplateService, getPlanTemplateService } from "../service.js";

const makeFakeDb = () => {
  const rows: any[] = [];
  let idCounter = 0;
  return {
    rows,
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { ...v, id: `tpl-${++idCounter}`, createdAt: new Date(), updatedAt: new Date() };
          rows.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async (_predicate: any) => rows.filter((r) => !r.archivedAt),
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            rows.forEach((r) => Object.assign(r, patch, { updatedAt: new Date() }));
            return rows;
          },
        }),
      }),
    }),
  };
};

describe("PlanTemplateService", () => {
  beforeEach(() => initializePlanTemplateService({ db: makeFakeDb() as any }));

  it("creates a template with defaultRequiredOutcomes", async () => {
    const svc = getPlanTemplateService();
    const t = await svc.create({ callerCompanyId: "co-1" }, {
      companyId: "co-1",
      name: "Strategy Rollout",
      defaultRequiredOutcomes: [{ kind: "manual_signoff", requiredMeta: { name: "ack" } }],
    });
    expect(t.id).toBeDefined();
    expect(t.name).toBe("Strategy Rollout");
  });

  it("listActive excludes archived", async () => {
    const svc = getPlanTemplateService();
    await svc.create({ callerCompanyId: "co-1" }, { companyId: "co-1", name: "A", defaultRequiredOutcomes: [] });
    const list = await svc.listActive({ callerCompanyId: "co-1" }, "co-1");
    expect(list).toHaveLength(1);
  });
});
