import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { getPlanTemplateService, PlanTemplateNotFoundError } from "../services/templates/service.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default_required_outcomes: z.array(z.any()).default([]),
  default_phases: z.array(z.any()).default([]),
});

const patchBodySchema = createBodySchema.partial();

export function planTemplatesRoutes(_db: Db): Router {
  const r = Router();

  r.get("/companies/:cid/plan-templates", async (req, res) => {
    const cid = req.params.cid as string;
    assertCompanyAccess(req, cid);
    const list = await getPlanTemplateService().listActive(
      { callerCompanyId: cid },
      cid,
    );
    res.json({ templates: list });
  });

  r.get("/companies/:cid/plan-templates/:id", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);
    try {
      const t = await getPlanTemplateService().getById(
        { callerCompanyId: cid },
        id,
      );
      if (!t) return res.status(404).json({ error: "not found" });
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: (e as Error).message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates", validate(createBodySchema), async (req, res) => {
    const cid = req.params.cid as string;
    assertCompanyAccess(req, cid);
    const body = req.body as z.infer<typeof createBodySchema>;
    const t = await getPlanTemplateService().create(
      { callerCompanyId: cid },
      {
        companyId: cid,
        name: body.name,
        description: body.description,
        defaultRequiredOutcomes: body.default_required_outcomes,
        defaultPhases: body.default_phases,
        createdByUserId: (req as any).actor?.userId ?? null,
      },
    );
    res.status(201).json(t);
  });

  r.patch("/companies/:cid/plan-templates/:id", validate(patchBodySchema), async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);
    try {
      const patch: Record<string, unknown> = {};
      if ("name" in req.body) patch.name = req.body.name;
      if ("description" in req.body) patch.description = req.body.description;
      if ("default_required_outcomes" in req.body) patch.defaultRequiredOutcomes = req.body.default_required_outcomes;
      if ("default_phases" in req.body) patch.defaultPhases = req.body.default_phases;
      const t = await getPlanTemplateService().update(
        { callerCompanyId: cid },
        id,
        patch,
      );
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: (e as Error).message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates/:id/archive", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);
    try {
      await getPlanTemplateService().archive(
        { callerCompanyId: cid },
        id,
      );
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: (e as Error).message });
      throw e;
    }
  });

  r.post("/companies/:cid/plan-templates/:id/restore", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);
    try {
      const t = await getPlanTemplateService().restore(
        { callerCompanyId: cid },
        id,
      );
      res.json(t);
    } catch (e) {
      if (e instanceof PlanTemplateNotFoundError) return res.status(404).json({ error: (e as Error).message });
      throw e;
    }
  });

  return r;
}
