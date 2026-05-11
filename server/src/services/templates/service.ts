import { and, eq, isNull } from "drizzle-orm";
import { planTemplates, type PlanTemplateRow, type NewPlanTemplateRow } from "@paperclipai/db";

interface ServiceCtx { callerCompanyId: string }
interface ServiceDeps { db: any }

export class PlanTemplateNotFoundError extends Error {
  statusCode = 404;
  constructor(id: string) { super(`Plan template not found: ${id}`); }
}

export class PlanTemplateService {
  constructor(private deps: ServiceDeps) {}

  private assertTenant(ctx: ServiceCtx, companyId: string) {
    if (ctx.callerCompanyId !== companyId) {
      throw new Error("PlanTemplate tenant mismatch");
    }
  }

  async create(
    ctx: ServiceCtx,
    input: { companyId: string; name: string; description?: string;
             defaultRequiredOutcomes: unknown[]; defaultPhases?: unknown[];
             createdByUserId?: string; createdByAgentId?: string },
  ): Promise<PlanTemplateRow> {
    this.assertTenant(ctx, input.companyId);
    const [row] = await this.deps.db.insert(planTemplates).values({
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? null,
      defaultRequiredOutcomes: input.defaultRequiredOutcomes,
      defaultPhases: input.defaultPhases ?? [],
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
    } as NewPlanTemplateRow).returning();
    return row;
  }

  async update(
    ctx: ServiceCtx,
    id: string,
    patch: Partial<{ name: string; description: string; defaultRequiredOutcomes: unknown[]; defaultPhases: unknown[] }>,
  ): Promise<PlanTemplateRow> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    const [updated] = await this.deps.db.update(planTemplates).set({
      ...patch,
      updatedAt: new Date(),
    }).where(eq(planTemplates.id, id)).returning();
    return updated;
  }

  async archive(ctx: ServiceCtx, id: string): Promise<void> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    await this.deps.db.update(planTemplates).set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(planTemplates.id, id));
  }

  async restore(ctx: ServiceCtx, id: string): Promise<PlanTemplateRow> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) throw new PlanTemplateNotFoundError(id);
    this.assertTenant(ctx, row.companyId);
    const [restored] = await this.deps.db.update(planTemplates)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(planTemplates.id, id))
      .returning();
    return restored;
  }

  async listActive(ctx: ServiceCtx, companyId: string): Promise<PlanTemplateRow[]> {
    this.assertTenant(ctx, companyId);
    return this.deps.db.select().from(planTemplates)
      .where(and(eq(planTemplates.companyId, companyId), isNull(planTemplates.archivedAt)));
  }

  async getById(ctx: ServiceCtx, id: string): Promise<PlanTemplateRow | null> {
    const [row] = await this.deps.db.select().from(planTemplates).where(eq(planTemplates.id, id));
    if (!row) return null;
    if (row.archivedAt) return null;  // treat archived as missing
    this.assertTenant(ctx, row.companyId);
    return row;
  }
}

let _instance: PlanTemplateService | null = null;
export function initializePlanTemplateService(deps: ServiceDeps): PlanTemplateService {
  _instance = new PlanTemplateService(deps);
  return _instance;
}
export function getPlanTemplateService(): PlanTemplateService {
  if (!_instance) throw new Error("PlanTemplateService not initialized");
  return _instance;
}
