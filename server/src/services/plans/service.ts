// Default in-process PlanService.
//
// createPlan: in one tx, insert plan + initial revision +
// optional phases + dependency edges (with cycle-check).
//
// revisePlan: insert a new revision row, bump current_revision_*
// on the plan, transition status → under_review when the policy
// requires re-review.
//
// submitReview: write the review row; on 'approved' for the
// current revision AND the approval policy is satisfied,
// transition plan to 'approved'.
//
// startPhase: validate readiness, transition phase → in_progress,
// and (optionally per phase_advance_policy + plan status)
// transition the plan into in_progress.
//
// completePhase: transition phase → completed; if all phases
// completed, transition plan to completed (memory-ingest hook
// in DP-10 fires from there).
//
// recordDecision: insert decision row (or supersede the prior
// decision when title collides).

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  planDecisions,
  planPhaseDependencies,
  planPhases,
  planRevisions,
  planReviews,
  plans,
} from "@paperclipai/db";
import { plansEvents } from "./events.js";
import { wouldCreateCycle, type DepEdge } from "./cycle-check.js";
import { validatePhaseTransition, validatePlanTransition } from "./lifecycle.js";
import { phaseReadiness } from "./phase-ready.js";
import {
  type ApprovalPolicy,
  type CreatePlanInput,
  type DecisionInput,
  type PhaseStatus,
  type PlanDecisionRow,
  type PlanPhaseRow,
  type PlanRevisionInput,
  type PlanRevisionRow,
  type PlanRow,
  type PlanService,
  type PlanServiceContext,
  PlanTenantMismatchError,
  type SubmitReviewInput,
} from "./types.js";
import {
  getPlanTemplateService,
  PlanTemplateNotFoundError,
} from "../templates/service.js";
import { getOutcomesService } from "../outcomes/service.js";
import { projectTemplateToContract } from "../templates/apply-template.js";
import { withSpan } from "../../observability/spans.js";
import { SPAN_APPLY_TEMPLATE } from "../outcomes/spans.js";
import { recordTemplateApplied } from "../outcomes/metrics.js";

export { PlanTemplateNotFoundError };

export interface PlanServiceOpts {
  db: Db;
  // On plan completion, the service fires this hook (DP-10 wires
  // it to the memory-ingest path).
  onPlanCompleted?: (planId: string) => Promise<void>;
}

export function createPlanService(opts: PlanServiceOpts): PlanService {
  function assertTenant(ctx: PlanServiceContext, companyId: string): void {
    if (ctx.callerCompanyId !== companyId) {
      throw new PlanTenantMismatchError(ctx.callerCompanyId, companyId);
    }
  }

  async function loadPlan(planId: string): Promise<typeof plans.$inferSelect | null> {
    const [row] = await opts.db.select().from(plans).where(eq(plans.id, planId));
    return row ?? null;
  }

  async function loadPhase(phaseId: string): Promise<typeof planPhases.$inferSelect | null> {
    const [row] = await opts.db
      .select()
      .from(planPhases)
      .where(eq(planPhases.id, phaseId));
    return row ?? null;
  }

  return {
    async createPlan(ctx, input: CreatePlanInput): Promise<PlanRow> {
      assertTenant(ctx, input.companyId);

      // EO-P2-9: look up the template BEFORE the plan insert so a
      // missing/archived template fails fast without creating an orphan plan row.
      let templateContract: ReturnType<typeof projectTemplateToContract> | null = null;
      if (input.templateId) {
        const tmpl = await getPlanTemplateService().getById(
          { callerCompanyId: input.companyId },
          input.templateId,
        );
        if (!tmpl) {
          throw new PlanTemplateNotFoundError(input.templateId);
        }
        templateContract = projectTemplateToContract(tmpl);
      }

      return opts.db.transaction(async (tx) => {
        const [plan] = await tx
          .insert(plans)
          .values({
            companyId: input.companyId,
            issueId: input.issueId ?? null,
            title: input.title,
            approvalPolicy: input.approvalPolicy ?? "one_human",
            phaseAdvancePolicy: input.phaseAdvancePolicy ?? "auto",
            createdByAgentId: input.createdByAgentId ?? null,
          })
          .returning();

        const [revision] = await tx
          .insert(planRevisions)
          .values({
            planId: plan.id,
            revisionNumber: 1,
            contentMarkdown: input.initialContent,
            createdByAgentId: input.createdByAgentId ?? null,
          })
          .returning();

        await tx
          .update(plans)
          .set({ currentRevisionId: revision.id, currentRevisionNumber: 1 })
          .where(eq(plans.id, plan.id));

        // Phases + DAG edges. dependsOnOrdering refs are resolved
        // to phase ids inside this same tx so cycle-check sees the
        // full edge set.
        if (input.phases && input.phases.length > 0) {
          const phaseRows = await tx
            .insert(planPhases)
            .values(
              input.phases.map((p, idx) => ({
                planId: plan.id,
                ordering: p.ordering ?? idx + 1,
                name: p.name,
                descriptionMarkdown: p.descriptionMarkdown ?? null,
                exitCriteriaMarkdown: p.exitCriteriaMarkdown ?? null,
                assigneeAgentId: p.assigneeAgentId ?? null,
              })),
            )
            .returning();

          const byOrdering = new Map<number, string>(
            phaseRows.map((r) => [r.ordering, r.id]),
          );
          const edges: DepEdge[] = [];
          for (let i = 0; i < input.phases.length; i++) {
            const draft = input.phases[i];
            const draftOrdering = draft.ordering ?? i + 1;
            const fromOrderings = draft.dependsOnOrdering ?? [];
            for (const dep of fromOrderings) {
              const fromId = byOrdering.get(dep);
              const toId = byOrdering.get(draftOrdering);
              if (!fromId || !toId) continue;
              const candidate: DepEdge = { fromPhaseId: fromId, toPhaseId: toId };
              if (wouldCreateCycle(edges, candidate)) {
                throw new Error(
                  `phase dependency would create a cycle: ${dep} → ${draftOrdering}`,
                );
              }
              edges.push(candidate);
            }
          }
          if (edges.length > 0) {
            await tx.insert(planPhaseDependencies).values(edges);
          }
        }

        // EO-P2-9: persist requiredOutcomes column inside the same transaction.
        if (templateContract && templateContract.length > 0) {
          await tx
            .update(plans)
            .set({ requiredOutcomes: templateContract })
            .where(eq(plans.id, plan.id));
        }

        return rowToPlan(plan);
      }).then(async (plan: PlanRow) => {
        // EO-P2-9: materializeContract runs outside the plan transaction
        // (it manages its own tx). Fire after the plan row is committed.
        if (templateContract && templateContract.length > 0) {
          await withSpan(
            SPAN_APPLY_TEMPLATE,
            async () => {
              await getOutcomesService().materializeContract(
                { kind: "plan", id: plan.id, companyId: input.companyId },
                templateContract as Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
              );
              recordTemplateApplied({ template_id_low_card: (input.templateId ?? "").slice(0, 8) });
            },
            {
              "outcome.template_id": input.templateId ?? "",
              "outcome.plan_id": plan.id,
              "outcome.contract_size": templateContract.length,
            },
          );
        }
        return plan;
      });
    },

    async revisePlan(
      ctx,
      planId,
      input: PlanRevisionInput,
    ): Promise<PlanRevisionRow> {
      const plan = await loadPlan(planId);
      if (!plan) throw new Error("plan not found");
      assertTenant(ctx, plan.companyId);

      return opts.db.transaction(async (tx) => {
        const nextNum = plan.currentRevisionNumber + 1;
        const [rev] = await tx
          .insert(planRevisions)
          .values({
            planId,
            revisionNumber: nextNum,
            parentRevisionId: plan.currentRevisionId,
            contentMarkdown: input.contentMarkdown,
            changeSummary: input.changeSummary,
            createdByAgentId: input.createdByAgentId ?? null,
          })
          .returning();

        // Mark the old revision as superseded.
        if (plan.currentRevisionId) {
          await tx
            .update(planRevisions)
            .set({ status: "superseded" })
            .where(eq(planRevisions.id, plan.currentRevisionId));
        }

        const update: Partial<typeof plans.$inferInsert> = {
          currentRevisionId: rev.id,
          currentRevisionNumber: nextNum,
          updatedAt: new Date(),
        };
        // Re-revision retriggers review per the approval policy.
        const requireRereview =
          plan.status === "approved" || plan.status === "in_progress";
        if (requireRereview && plan.approvalPolicy !== "none") {
          if (validatePlanTransition(plan.status as PlanRow["status"], "under_review").ok) {
            update.status = "under_review";
            update.approvedAt = null;
          }
        } else if (plan.status === "draft" || plan.status === "rejected") {
          // Stay in same draft-ish state.
        }
        await tx.update(plans).set(update).where(eq(plans.id, planId));

        return rowToRevision(rev);
      });
    },

    async submitReview(ctx, planId, input: SubmitReviewInput): Promise<void> {
      const plan = await loadPlan(planId);
      if (!plan) throw new Error("plan not found");
      assertTenant(ctx, plan.companyId);

      const stampRevisionId = input.revisionId ?? plan.currentRevisionId;

      await opts.db.transaction(async (tx) => {
        await tx.insert(planReviews).values({
          planId,
          revisionId: stampRevisionId,
          decision: input.decision,
          commentMarkdown: input.comment ?? null,
          reviewerAgentId: input.reviewerAgentId ?? null,
        });

        if (input.decision === "approved" && stampRevisionId === plan.currentRevisionId) {
          if (decideApprovalQuorum(plan.approvalPolicy as ApprovalPolicy)) {
            const t = validatePlanTransition(plan.status as PlanRow["status"], "approved");
            if (t.ok) {
              await tx
                .update(plans)
                .set({ status: "approved", approvedAt: new Date(), updatedAt: new Date() })
                .where(eq(plans.id, planId));
              await tx
                .update(planRevisions)
                .set({ status: "approved" })
                .where(eq(planRevisions.id, stampRevisionId!));
            }
          }
        } else if (input.decision === "rejected") {
          const t = validatePlanTransition(plan.status as PlanRow["status"], "rejected");
          if (t.ok) {
            await tx
              .update(plans)
              .set({ status: "rejected", updatedAt: new Date() })
              .where(eq(plans.id, planId));
          }
        } else if (input.decision === "requested_changes" && plan.status !== "under_review") {
          const t = validatePlanTransition(plan.status as PlanRow["status"], "under_review");
          if (t.ok) {
            await tx
              .update(plans)
              .set({ status: "under_review", updatedAt: new Date() })
              .where(eq(plans.id, planId));
          }
        }
      });
    },

    async startPhase(ctx, phaseId): Promise<void> {
      const phase = await loadPhase(phaseId);
      if (!phase) throw new Error("phase not found");
      const plan = await loadPlan(phase.planId);
      if (!plan) throw new Error("plan not found");
      assertTenant(ctx, plan.companyId);

      const deps = await opts.db
        .select({ fromPhaseId: planPhaseDependencies.fromPhaseId })
        .from(planPhaseDependencies)
        .where(eq(planPhaseDependencies.toPhaseId, phaseId));
      let depStatuses: PhaseStatus[] = [];
      if (deps.length > 0) {
        const ids = deps.map((d) => d.fromPhaseId);
        const depRows = await opts.db
          .select({ id: planPhases.id, status: planPhases.status })
          .from(planPhases)
          .where(sql`${planPhases.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`,`)})`);
        depStatuses = depRows.map((r) => r.status as PhaseStatus);
      }
      const readiness = phaseReadiness({ depStatuses });
      if (readiness !== "ready") {
        throw new Error(`phase is not ready: ${readiness}`);
      }
      const t = validatePhaseTransition(phase.status as PhaseStatus, "in_progress");
      if (!t.ok) throw new Error(t.reason!);

      await opts.db.transaction(async (tx) => {
        await tx
          .update(planPhases)
          .set({ status: "in_progress", startedAt: new Date() })
          .where(eq(planPhases.id, phaseId));

        if (plan.status === "approved") {
          await tx
            .update(plans)
            .set({ status: "in_progress", updatedAt: new Date() })
            .where(eq(plans.id, plan.id));
        }
      });
    },

    async completePhase(ctx, phaseId, exitCriteriaMet): Promise<void> {
      const phase = await loadPhase(phaseId);
      if (!phase) throw new Error("phase not found");
      const plan = await loadPlan(phase.planId);
      if (!plan) throw new Error("plan not found");
      assertTenant(ctx, plan.companyId);

      if (!exitCriteriaMet) {
        throw new Error("exit criteria not met");
      }
      const t = validatePhaseTransition(phase.status as PhaseStatus, "completed");
      if (!t.ok) throw new Error(t.reason!);

      const allCompletedAfter = await opts.db.transaction(async (tx) => {
        await tx
          .update(planPhases)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(planPhases.id, phaseId));

        // Are all phases done? If yes, transition the plan.
        const remaining = await tx
          .select({ id: planPhases.id })
          .from(planPhases)
          .where(
            and(
              eq(planPhases.planId, plan.id),
              sql`${planPhases.status} NOT IN ('completed','skipped')`,
            ),
          )
          .limit(1);
        if (remaining.length === 0) {
          const transition = validatePlanTransition(plan.status as PlanRow["status"], "completed");
          if (transition.ok) {
            await tx
              .update(plans)
              .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
              .where(eq(plans.id, plan.id));
            return true;
          }
        }
        return false;
      });

      if (allCompletedAfter && opts.onPlanCompleted) {
        try {
          await opts.onPlanCompleted(plan.id);
        } catch {
          // Memory-ingest failure must not block the plan
          // completion. Log via the caller's error path.
        }
      }

      // Emit AFTER the transaction commits — never inside it.
      const phasePayload = {
        planPhaseId: phaseId,
        companyId: plan.companyId,
        planId: plan.id,
        planIssueId: plan.issueId ?? null,
        exitCriteriaMarkdown: phase.exitCriteriaMarkdown ?? "",
      };
      plansEvents.emit("phaseCompleted", phasePayload);
      // phaseMarkdownUpdated fires alongside phaseCompleted — there is no
      // separate "phase markdown update" write path in Plan 1; both events
      // carry the same payload so exit_criteria_met verifiers see it.
      plansEvents.emit("phaseMarkdownUpdated", phasePayload);

      if (allCompletedAfter) {
        plansEvents.emit("completed", {
          planId: plan.id,
          companyId: plan.companyId,
          issueId: plan.issueId ?? null,
          completedAt: new Date(),
          revisionId: plan.currentRevisionId ?? null,
        });
      }
    },

    async recordDecision(ctx, planId, input: DecisionInput): Promise<PlanDecisionRow> {
      const plan = await loadPlan(planId);
      if (!plan) throw new Error("plan not found");
      assertTenant(ctx, plan.companyId);

      const [row] = await opts.db
        .insert(planDecisions)
        .values({
          planId,
          phaseId: input.phaseId ?? null,
          title: input.title,
          optionsJson: input.options,
          chosenOptionId: input.chosenOptionId,
          rationaleMarkdown: input.rationaleMarkdown ?? null,
          decidedByAgentId: input.decidedByAgentId ?? null,
        })
        .returning();

      // Emit AFTER the DB insert commits — never inside a transaction.
      plansEvents.emit("decisionRecorded", {
        decisionId: row.id,
        companyId: plan.companyId,
        planId,
        planIssueId: plan.issueId ?? null,
        title: row.title,
        chosenOptionId: row.chosenOptionId ?? null,
        decidedAt: row.decidedAt,
      });

      return rowToDecision(row);
    },

    async forget(ctx, planId): Promise<void> {
      const plan = await loadPlan(planId);
      if (!plan) return;
      assertTenant(ctx, plan.companyId);
      // Cascades from FKs handle revisions / phases / reviews /
      // decisions / phase_runs.
      await opts.db.delete(plans).where(eq(plans.id, planId));
    },
  };
}

function decideApprovalQuorum(policy: ApprovalPolicy): boolean {
  // v1 quorum: 'one_human' / 'agent_only' / 'all_assignees' all
  // approve on a single approve. Multi-quorum lands in Plan 2.
  // 'none' approves at create time and never re-reviews.
  return policy !== "none";
}

function rowToPlan(row: typeof plans.$inferSelect): PlanRow {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    title: row.title,
    status: row.status as PlanRow["status"],
    currentRevisionId: row.currentRevisionId,
    currentRevisionNumber: row.currentRevisionNumber,
    approvalPolicy: row.approvalPolicy as PlanRow["approvalPolicy"],
    phaseAdvancePolicy: row.phaseAdvancePolicy as PlanRow["phaseAdvancePolicy"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
    completedAt: row.completedAt,
  };
}

function rowToRevision(row: typeof planRevisions.$inferSelect): PlanRevisionRow {
  return {
    id: row.id,
    planId: row.planId,
    revisionNumber: row.revisionNumber,
    parentRevisionId: row.parentRevisionId,
    contentMarkdown: row.contentMarkdown,
    changeSummary: row.changeSummary,
    status: row.status as PlanRevisionRow["status"],
    createdAt: row.createdAt,
  };
}

function rowToDecision(row: typeof planDecisions.$inferSelect): PlanDecisionRow {
  return {
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    title: row.title,
    options: row.optionsJson as PlanDecisionRow["options"],
    chosenOptionId: row.chosenOptionId,
    rationaleMarkdown: row.rationaleMarkdown,
    decidedAt: row.decidedAt,
    supersededById: row.supersededById,
  };
}

let singleton: PlanService | null = null;
export function initializePlanService(opts: PlanServiceOpts): PlanService {
  singleton = createPlanService(opts);
  return singleton;
}
export function getPlanService(): PlanService {
  if (!singleton) {
    throw new Error("PlanService not initialized — call initializePlanService at boot");
  }
  return singleton;
}

// Used by routes/load layer; suppress unused-import lint.
export { rowToPlan as _rowToPlan, rowToRevision as _rowToRevision };
// Suppress unused PlanPhaseRow import warning.
export type { PlanPhaseRow };
