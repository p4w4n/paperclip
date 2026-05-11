// Plans REST surface.
//
//   POST   /api/issues/:issueId/plans               create
//   GET    /api/plans/:id                           current revision + phases
//   GET    /api/plans/:id/revisions                 list revisions
//   POST   /api/plans/:id/revisions                 revise
//   POST   /api/plans/:id/reviews                   submit review
//   POST   /api/plans/:id/phases/:phaseId/start
//   POST   /api/plans/:id/phases/:phaseId/complete
//   POST   /api/plans/:id/decisions                 record
//   GET    /api/companies/:cid/plans                index, filter by status
//
// Tenant gate: derive companyId from the row, assertCompanyAccess,
// then service-layer assertTenant. Defense in depth.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { plans, planRevisions, planPhases, planReviews, planDecisions } from "@paperclipai/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { issueService } from "../services/index.js";
import { getPlanService } from "../services/plans/service.js";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { allOutcomesVerified } from "../services/outcomes/predicate.js";
import { OutcomeRequiredError } from "../services/outcomes/types.js";
import { getOutcomesService } from "../services/outcomes/service.js";
import { recordGateBlocked } from "../services/outcomes/metrics.js";

const phaseDraftSchema = z.object({
  name: z.string().min(1),
  descriptionMarkdown: z.string().optional(),
  exitCriteriaMarkdown: z.string().optional(),
  ordering: z.number().int().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dependsOnOrdering: z.array(z.number().int()).optional(),
});

const createPlanBodySchema = z.object({
  title: z.string().min(1),
  initialContent: z.string().min(1),
  approvalPolicy: z.enum(["one_human", "all_assignees", "agent_only", "none"]).optional(),
  phaseAdvancePolicy: z.enum(["auto", "manual"]).optional(),
  phases: z.array(phaseDraftSchema).optional(),
});

const reviseBodySchema = z.object({
  contentMarkdown: z.string().min(1),
  changeSummary: z.string().min(1),
});

const reviewBodySchema = z.object({
  decision: z.enum(["approved", "requested_changes", "rejected"]),
  revisionId: z.string().uuid().optional(),
  comment: z.string().optional(),
});

const decisionBodySchema = z.object({
  title: z.string().min(1),
  options: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
  chosenOptionId: z.string(),
  rationaleMarkdown: z.string().optional(),
  phaseId: z.string().uuid().optional(),
});

const requiredOutcomeItemSchema = z.object({
  kind: z.string().min(1),
  requiredMeta: z.record(z.unknown()),
});

const patchPlanBodySchema = z.object({
  requiredOutcomes: z.array(requiredOutcomeItemSchema).optional(),
});

export function plansRoutes(db: Db) {
  const router = Router();
  const issueSvc = issueService(db);

  router.post(
    "/issues/:issueId/plans",
    validate(createPlanBodySchema),
    async (req, res) => {
      const rawId = req.params.issueId as string;
      const identifier = normalizeIssueIdentifier(rawId);
      const issue = identifier
        ? await issueSvc.getByIdentifier(identifier)
        : await issueSvc.getById(rawId);
      if (!issue) throw notFound("issue not found");
      assertCompanyAccess(req, issue.companyId);
      const body = req.body as z.infer<typeof createPlanBodySchema>;
      const svc = getPlanService();
      const plan = await svc.createPlan(
        { callerCompanyId: issue.companyId },
        {
          companyId: issue.companyId,
          issueId: issue.id,
          title: body.title,
          initialContent: body.initialContent,
          approvalPolicy: body.approvalPolicy,
          phaseAdvancePolicy: body.phaseAdvancePolicy,
          phases: body.phases,
        },
      );
      res.status(201).json({ plan });
    },
  );

  router.get("/plans/:id", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlan(db, id);
    if (!peek) throw notFound("plan not found");
    assertCompanyAccess(req, peek.companyId);
    const [plan] = await db.select().from(plans).where(eq(plans.id, id));
    if (!plan) throw notFound("plan not found");
    let currentRev: typeof planRevisions.$inferSelect | null = null;
    if (plan.currentRevisionId) {
      const [r] = await db
        .select()
        .from(planRevisions)
        .where(eq(planRevisions.id, plan.currentRevisionId));
      currentRev = r ?? null;
    }
    const phases = await db
      .select()
      .from(planPhases)
      .where(eq(planPhases.planId, id))
      .orderBy(asc(planPhases.ordering));
    res.json({ plan, currentRevision: currentRev, phases });
  });

  // EO-13 Part A: PATCH /plans/:id — contract write for required_outcomes.
  router.patch(
    "/plans/:id",
    validate(patchPlanBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const peek = await peekPlan(db, id);
      if (!peek) throw notFound("plan not found");
      assertCompanyAccess(req, peek.companyId);
      const body = req.body as z.infer<typeof patchPlanBodySchema>;
      if (Array.isArray(body.requiredOutcomes)) {
        await getOutcomesService().materializeContract(
          { kind: "plan", id, companyId: peek.companyId },
          body.requiredOutcomes as Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
        );
        // Persist the JSONB column so the gate guard at phase-complete sees the contract on
        // subsequent requests. (Fix for EO Bug 1: the column was previously never written.)
        await db
          .update(plans)
          .set({ requiredOutcomes: body.requiredOutcomes as unknown[] })
          .where(eq(plans.id, id));
      }
      res.json({ ok: true });
    },
  );

  router.get("/plans/:id/revisions", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlan(db, id);
    if (!peek) throw notFound("plan not found");
    assertCompanyAccess(req, peek.companyId);
    const rows = await db
      .select()
      .from(planRevisions)
      .where(eq(planRevisions.planId, id))
      .orderBy(desc(planRevisions.revisionNumber));
    res.json({ revisions: rows });
  });

  router.post(
    "/plans/:id/revisions",
    validate(reviseBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const peek = await peekPlan(db, id);
      if (!peek) throw notFound("plan not found");
      assertCompanyAccess(req, peek.companyId);
      const body = req.body as z.infer<typeof reviseBodySchema>;
      const svc = getPlanService();
      const rev = await svc.revisePlan(
        { callerCompanyId: peek.companyId },
        id,
        {
          contentMarkdown: body.contentMarkdown,
          changeSummary: body.changeSummary,
        },
      );
      res.status(201).json({ revision: rev });
    },
  );

  router.post(
    "/plans/:id/reviews",
    validate(reviewBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const peek = await peekPlan(db, id);
      if (!peek) throw notFound("plan not found");
      assertCompanyAccess(req, peek.companyId);
      const body = req.body as z.infer<typeof reviewBodySchema>;
      const svc = getPlanService();
      await svc.submitReview(
        { callerCompanyId: peek.companyId },
        id,
        body,
      );
      res.json({ ok: true });
    },
  );

  router.post("/plans/:id/phases/:phaseId/start", async (req, res) => {
    const id = req.params.id as string;
    const phaseId = req.params.phaseId as string;
    const peek = await peekPlan(db, id);
    if (!peek) throw notFound("plan not found");
    assertCompanyAccess(req, peek.companyId);
    const svc = getPlanService();
    await svc.startPhase({ callerCompanyId: peek.companyId }, phaseId);
    res.json({ ok: true });
  });

  router.post("/plans/:id/phases/:phaseId/complete", async (req, res) => {
    const id = req.params.id as string;
    const phaseId = req.params.phaseId as string;
    const planRow = await peekPlanFull(db, id);
    if (!planRow) throw notFound("plan not found");
    assertCompanyAccess(req, planRow.companyId);
    const exitCriteriaMet = req.body?.exitCriteriaMet === true;

    // EO-13 Part B: gate check — reject phase completion when plan has pending required outcomes.
    if (Array.isArray(planRow.requiredOutcomes) && planRow.requiredOutcomes.length > 0) {
      const gateResult = await allOutcomesVerified(db, {
        kind: "plan",
        id: planRow.id,
        companyId: planRow.companyId,
      });
      if (gateResult instanceof OutcomeRequiredError) {
        recordGateBlocked("plan");
        res.status(422).json(gateResult.body);
        return;
      }
    }

    const svc = getPlanService();
    await svc.completePhase(
      { callerCompanyId: planRow.companyId },
      phaseId,
      exitCriteriaMet,
    );
    res.json({ ok: true });
  });

  router.post(
    "/plans/:id/decisions",
    validate(decisionBodySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const peek = await peekPlan(db, id);
      if (!peek) throw notFound("plan not found");
      assertCompanyAccess(req, peek.companyId);
      const body = req.body as z.infer<typeof decisionBodySchema>;
      const svc = getPlanService();
      const decision = await svc.recordDecision(
        { callerCompanyId: peek.companyId },
        id,
        body,
      );
      res.status(201).json({ decision });
    },
  );

  router.get("/companies/:companyId/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const filters = [eq(plans.companyId, companyId)];
    if (status) filters.push(eq(plans.status, status));
    const rows = await db
      .select()
      .from(plans)
      .where(and(...filters))
      .orderBy(desc(plans.updatedAt))
      .limit(200);
    res.json({ plans: rows });
  });

  // Decisions per plan (for the UI decision log).
  router.get("/plans/:id/decisions", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlan(db, id);
    if (!peek) throw notFound("plan not found");
    assertCompanyAccess(req, peek.companyId);
    const rows = await db
      .select()
      .from(planDecisions)
      .where(eq(planDecisions.planId, id))
      .orderBy(desc(planDecisions.decidedAt));
    res.json({ decisions: rows });
  });

  // Reviews per plan (for the review surface).
  router.get("/plans/:id/reviews", async (req, res) => {
    const id = req.params.id as string;
    const peek = await peekPlan(db, id);
    if (!peek) throw notFound("plan not found");
    assertCompanyAccess(req, peek.companyId);
    const rows = await db
      .select()
      .from(planReviews)
      .where(eq(planReviews.planId, id))
      .orderBy(desc(planReviews.createdAt));
    res.json({ reviews: rows });
  });

  return router;
}

async function peekPlan(db: Db, id: string): Promise<{ companyId: string } | null> {
  const [row] = await db
    .select({ companyId: plans.companyId })
    .from(plans)
    .where(eq(plans.id, id))
    .limit(1);
  return row ? { companyId: row.companyId } : null;
}

async function peekPlanFull(
  db: Db,
  id: string,
): Promise<{ id: string; companyId: string; requiredOutcomes: unknown[] } | null> {
  const [row] = await db
    .select({ id: plans.id, companyId: plans.companyId, requiredOutcomes: plans.requiredOutcomes })
    .from(plans)
    .where(eq(plans.id, id))
    .limit(1);
  return row
    ? { id: row.id, companyId: row.companyId, requiredOutcomes: (row.requiredOutcomes as unknown[]) ?? [] }
    : null;
}
