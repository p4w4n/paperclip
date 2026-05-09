// GET /api/plans/:id/artifacts — discovers artifacts whose
// content_meta.plan_id matches the requested plan. Read-only;
// declares still go through the artifacts service via the
// existing routes.
//
// Tenant gate: plan row → companyId → assertCompanyAccess +
// artifacts service tenant guard (defense in depth).

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { artifacts, plans } from "@paperclipai/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export function plansArtifactsRoutes(db: Db) {
  const router = Router();

  router.get("/plans/:id/artifacts", async (req, res) => {
    const id = req.params.id as string;
    const [plan] = await db
      .select({ companyId: plans.companyId })
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1);
    if (!plan) throw notFound("plan not found");
    assertCompanyAccess(req, plan.companyId);
    const includeSuperseded = req.query.includeSuperseded === "true";
    const filters = [
      eq(artifacts.companyId, plan.companyId),
      // Match artifacts where content_meta.plan_id == :id.
      sql`${artifacts.contentMeta} ->> 'plan_id' = ${id}`,
    ];
    if (!includeSuperseded) filters.push(isNull(artifacts.supersededAt));
    const rows = await db
      .select()
      .from(artifacts)
      .where(and(...filters))
      .orderBy(desc(artifacts.declaredAt))
      .limit(200);
    res.json({ artifacts: rows });
  });

  return router;
}
