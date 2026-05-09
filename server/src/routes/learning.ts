// Learning REST surface.
//
//   POST /api/companies/:cid/playbooks
//   GET  /api/companies/:cid/playbooks?status=...&agentId=...
//   GET  /api/playbooks/:id
//   POST /api/playbooks/:id/revisions
//   POST /api/playbooks/:id/approve
//   POST /api/playbooks/:id/archive
//
//   GET  /api/companies/:cid/outcome-patterns
//   POST /api/outcome-patterns/:id/promote
//
//   GET  /api/agents/:agentId/skills
//   GET  /api/companies/:cid/decision-patterns
//
//   POST /api/companies/:cid/playbooks/suggest

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { agents, outcomePatterns, playbooks } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getOrgLearningService } from "../services/learning/service.js";
import { suggestPlaybooks } from "../services/learning/suggest.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";

const createPlaybookBodySchema = z.object({
  agentId: z.string().uuid().optional(),
  title: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  contentMarkdown: z.string().min(1),
  applicabilityConditions: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["proposed", "active"]).optional(),
});

const reviseBodySchema = z.object({
  contentMarkdown: z.string().min(1),
  changeSummary: z.string().min(1),
  applicabilityConditions: z.record(z.unknown()).optional(),
});

const promoteBodySchema = z.object({
  contentMarkdown: z.string().min(1),
  title: z.string().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

const suggestBodySchema = z.object({
  issueContext: z.object({
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).default([]),
    projectId: z.string().uuid().optional(),
    assigneeAgentId: z.string().uuid().optional(),
  }),
  threshold: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export function learningRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/playbooks",
    validate(createPlaybookBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = req.body as z.infer<typeof createPlaybookBodySchema>;
      const svc = getOrgLearningService();
      const pb = await svc.createPlaybook(
        { callerCompanyId: companyId },
        {
          companyId,
          agentId: body.agentId,
          title: body.title,
          slug: body.slug,
          contentMarkdown: body.contentMarkdown,
          applicabilityConditions: body.applicabilityConditions,
          confidence: body.confidence,
          status: body.status,
        },
      );
      res.status(201).json({ playbook: pb });
    },
  );

  router.get("/companies/:companyId/playbooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = (req.query.status as string | undefined) as
      | "proposed"
      | "active"
      | "archived"
      | "superseded"
      | undefined;
    const agentIdParam = req.query.agentId as string | undefined;
    const agentId = agentIdParam === "null" ? null : agentIdParam;
    const svc = getOrgLearningService();
    const list = await svc.listPlaybooks(
      { callerCompanyId: companyId },
      { companyId, status, agentId },
    );
    res.json({ playbooks: list });
  });

  router.get("/playbooks/:id", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlaybook(db, id);
    if (!peek) throw notFound("playbook not found");
    assertCompanyAccess(req, peek.companyId);
    const svc = getOrgLearningService();
    const out = await svc.getPlaybook({ callerCompanyId: peek.companyId }, id);
    if (!out) throw notFound("playbook not found");
    res.json(out);
  });

  router.post(
    "/playbooks/:id/revisions",
    validate(reviseBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const peek = await peekPlaybook(db, id);
      if (!peek) throw notFound("playbook not found");
      assertCompanyAccess(req, peek.companyId);
      const body = req.body as z.infer<typeof reviseBodySchema>;
      const svc = getOrgLearningService();
      const rev = await svc.revisePlaybook(
        { callerCompanyId: peek.companyId },
        id,
        {
          contentMarkdown: body.contentMarkdown,
          changeSummary: body.changeSummary,
          applicabilityConditions: body.applicabilityConditions,
        },
      );
      res.status(201).json({ revision: rev });
    },
  );

  router.post("/playbooks/:id/approve", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlaybook(db, id);
    if (!peek) throw notFound("playbook not found");
    assertCompanyAccess(req, peek.companyId);
    const svc = getOrgLearningService();
    await svc.approvePlaybook({ callerCompanyId: peek.companyId }, id);
    res.json({ ok: true });
  });

  router.post("/playbooks/:id/archive", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlaybook(db, id);
    if (!peek) throw notFound("playbook not found");
    assertCompanyAccess(req, peek.companyId);
    const svc = getOrgLearningService();
    await svc.archivePlaybook({ callerCompanyId: peek.companyId }, id);
    res.json({ ok: true });
  });

  router.get("/companies/:companyId/outcome-patterns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const svc = getOrgLearningService();
    const list = await svc.listOutcomePatterns(
      { callerCompanyId: companyId },
      { companyId },
    );
    res.json({ patterns: list });
  });

  router.post(
    "/outcome-patterns/:id/promote",
    validate(promoteBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const [pat] = await db
        .select({ companyId: outcomePatterns.companyId })
        .from(outcomePatterns)
        .where(eq(outcomePatterns.id, id))
        .limit(1);
      if (!pat) throw notFound("pattern not found");
      assertCompanyAccess(req, pat.companyId);
      const body = req.body as z.infer<typeof promoteBodySchema>;
      const svc = getOrgLearningService();
      const pb = await svc.promotePatternToPlaybook(
        { callerCompanyId: pat.companyId },
        id,
        body,
      );
      res.status(201).json({ playbook: pb });
    },
  );

  router.get("/agents/:agentId/skills", async (req, res) => {
    const agentId = req.params.agentId as string;
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) throw notFound("agent not found");
    assertCompanyAccess(req, agent.companyId);
    const svc = getOrgLearningService();
    const skills = await svc.listAgentSkills(
      { callerCompanyId: agent.companyId },
      { agentId, companyId: agent.companyId },
    );
    res.json({ skills });
  });

  router.get("/companies/:companyId/decision-patterns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const svc = getOrgLearningService();
    const list = await svc.listDecisionPatterns(
      { callerCompanyId: companyId },
      { companyId },
    );
    res.json({ patterns: list });
  });

  router.post(
    "/companies/:companyId/playbooks/suggest",
    validate(suggestBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = req.body as z.infer<typeof suggestBodySchema>;
      const svc = getOrgLearningService();
      const out = await suggestPlaybooks(
        svc,
        { callerCompanyId: companyId },
        {
          companyId,
          issueContext: body.issueContext,
          threshold: body.threshold,
          limit: body.limit,
        },
      );
      res.json({ suggestions: out });
    },
  );

  return router;
}

async function peekPlaybook(
  db: Db,
  id: string,
): Promise<{ companyId: string } | null> {
  const [row] = await db
    .select({ companyId: playbooks.companyId })
    .from(playbooks)
    .where(eq(playbooks.id, id))
    .limit(1);
  return row ? { companyId: row.companyId } : null;
}
