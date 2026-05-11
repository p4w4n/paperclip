// Default in-process OrgLearningService.
//
// createPlaybook + revisePlaybook + approve + archive + listing.
// suggestPlaybooks lands separately in L-9; pattern + skill +
// decision-pattern reads land here as thin queries; promotion is
// here too (turns an outcome_pattern into an active playbook).

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentSkills,
  decisionPatterns,
  outcomePatterns,
  playbookRevisions,
  playbooks,
} from "@paperclipai/db";
import { matchPlaybookApplicability } from "./applicability.js";
import {
  LearningTenantMismatchError,
  type AgentSkill,
  type CreatePlaybookInput,
  type DecisionPattern,
  type OrgLearningService,
  type OrgLearningServiceContext,
  type OutcomePattern,
  type Playbook,
  type PlaybookRevision,
  type PlaybookStatus,
  type RevisePlaybookInput,
  type SuggestionResult,
} from "./types.js";

export interface OrgLearningServiceOpts {
  db: Db;
}

export function createOrgLearningService(
  opts: OrgLearningServiceOpts,
): OrgLearningService {
  function assertTenant(ctx: OrgLearningServiceContext, companyId: string): void {
    if (ctx.callerCompanyId !== companyId) {
      throw new LearningTenantMismatchError(ctx.callerCompanyId, companyId);
    }
  }

  return {
    async createPlaybook(ctx, input: CreatePlaybookInput): Promise<Playbook> {
      assertTenant(ctx, input.companyId);
      return opts.db.transaction(async (tx) => {
        const [pb] = await tx
          .insert(playbooks)
          .values({
            companyId: input.companyId,
            agentId: input.agentId ?? null,
            title: input.title,
            slug: input.slug,
            status: input.status ?? "proposed",
            applicabilityConditions: (input.applicabilityConditions ??
              null) as Record<string, unknown> | null,
            sourceRunIds: input.sourceRunIds ?? null,
            sourcePlanIds: input.sourcePlanIds ?? null,
            confidence: input.confidence ?? 0.5,
          })
          .returning();
        const [rev] = await tx
          .insert(playbookRevisions)
          .values({
            playbookId: pb.id,
            revisionNumber: 1,
            contentMarkdown: input.contentMarkdown,
            createdByAgentId: input.createdByAgentId ?? null,
          })
          .returning();
        await tx
          .update(playbooks)
          .set({ currentRevisionId: rev.id })
          .where(eq(playbooks.id, pb.id));
        return rowToPlaybook({ ...pb, currentRevisionId: rev.id });
      });
    },

    async revisePlaybook(ctx, id, input: RevisePlaybookInput): Promise<PlaybookRevision> {
      const [pb] = await opts.db.select().from(playbooks).where(eq(playbooks.id, id));
      if (!pb) throw new Error("playbook not found");
      assertTenant(ctx, pb.companyId);
      return opts.db.transaction(async (tx) => {
        const next = pb.currentRevisionNumber + 1;
        const [rev] = await tx
          .insert(playbookRevisions)
          .values({
            playbookId: id,
            revisionNumber: next,
            parentRevisionId: pb.currentRevisionId,
            contentMarkdown: input.contentMarkdown,
            changeSummary: input.changeSummary,
            createdByAgentId: input.createdByAgentId ?? null,
          })
          .returning();
        const update: Partial<typeof playbooks.$inferInsert> = {
          currentRevisionId: rev.id,
          currentRevisionNumber: next,
          updatedAt: new Date(),
        };
        if (input.applicabilityConditions !== undefined) {
          update.applicabilityConditions = input.applicabilityConditions as
            | Record<string, unknown>
            | null;
        }
        await tx.update(playbooks).set(update).where(eq(playbooks.id, id));
        return rowToRevision(rev);
      });
    },

    async approvePlaybook(ctx, id): Promise<void> {
      const [pb] = await opts.db.select().from(playbooks).where(eq(playbooks.id, id));
      if (!pb) throw new Error("playbook not found");
      assertTenant(ctx, pb.companyId);
      await opts.db
        .update(playbooks)
        .set({ status: "active", approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(playbooks.id, id));
    },

    async archivePlaybook(ctx, id): Promise<void> {
      const [pb] = await opts.db.select().from(playbooks).where(eq(playbooks.id, id));
      if (!pb) throw new Error("playbook not found");
      assertTenant(ctx, pb.companyId);
      await opts.db
        .update(playbooks)
        .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(playbooks.id, id));
    },

    async listPlaybooks(ctx, filter): Promise<Playbook[]> {
      assertTenant(ctx, filter.companyId);
      const conditions = [eq(playbooks.companyId, filter.companyId)];
      if (filter.status) conditions.push(eq(playbooks.status, filter.status));
      if (filter.agentId === null) conditions.push(isNull(playbooks.agentId));
      else if (filter.agentId) conditions.push(eq(playbooks.agentId, filter.agentId));
      const rows = await opts.db
        .select()
        .from(playbooks)
        .where(and(...conditions))
        .orderBy(desc(playbooks.updatedAt))
        .limit(filter.limit ?? 200);
      return rows.map(rowToPlaybook);
    },

    async getPlaybook(ctx, id) {
      const [pb] = await opts.db.select().from(playbooks).where(eq(playbooks.id, id));
      if (!pb) return null;
      assertTenant(ctx, pb.companyId);
      let currentRevision: PlaybookRevision | null = null;
      if (pb.currentRevisionId) {
        const [r] = await opts.db
          .select()
          .from(playbookRevisions)
          .where(eq(playbookRevisions.id, pb.currentRevisionId));
        if (r) currentRevision = rowToRevision(r);
      }
      return { playbook: rowToPlaybook(pb), currentRevision };
    },

    async listOutcomePatterns(ctx, filter): Promise<OutcomePattern[]> {
      assertTenant(ctx, filter.companyId);
      const rows = await opts.db
        .select()
        .from(outcomePatterns)
        .where(
          and(
            eq(outcomePatterns.companyId, filter.companyId),
            isNull(outcomePatterns.archivedAt),
          ),
        )
        .orderBy(desc(outcomePatterns.derivedAt))
        .limit(filter.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        patternName: r.patternName,
        patternDescription: r.patternDescription,
        exemplarRunIds: r.exemplarRunIds ?? [],
        clusterSize: r.clusterSize,
        derivedAt: r.derivedAt,
        confidence: r.confidence,
        promotedToPlaybookId: r.promotedToPlaybookId,
        archivedAt: r.archivedAt,
      }));
    },

    async promotePatternToPlaybook(ctx, patternId, input): Promise<Playbook> {
      const [pat] = await opts.db
        .select()
        .from(outcomePatterns)
        .where(eq(outcomePatterns.id, patternId));
      if (!pat) throw new Error("pattern not found");
      assertTenant(ctx, pat.companyId);
      const slug = input.slug ?? toSlug(pat.patternName);
      const title = input.title ?? pat.patternName;
      const pb = await this.createPlaybook(ctx, {
        companyId: pat.companyId,
        title,
        slug,
        contentMarkdown: input.contentMarkdown,
        sourceRunIds: pat.exemplarRunIds ?? undefined,
        confidence: pat.confidence,
        status: "active",
        applicabilityConditions: { issue_keywords: pat.patternName.toLowerCase().split(/\s+/).filter(Boolean) },
      });
      await opts.db
        .update(outcomePatterns)
        .set({ promotedToPlaybookId: pb.id })
        .where(eq(outcomePatterns.id, patternId));
      return pb;
    },

    async listAgentSkills(ctx, filter): Promise<AgentSkill[]> {
      assertTenant(ctx, filter.companyId);
      const rows = await opts.db
        .select()
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.agentId, filter.agentId),
            eq(agentSkills.companyId, filter.companyId),
          ),
        )
        .orderBy(desc(agentSkills.confidence));
      return rows.map((r) => ({
        agentId: r.agentId,
        companyId: r.companyId,
        skillName: r.skillName,
        evidenceRunIds: r.evidenceRunIds ?? [],
        lastEvidencedAt: r.lastEvidencedAt,
        confidence: r.confidence,
        derivedAt: r.derivedAt,
      }));
    },

    async listDecisionPatterns(ctx, filter): Promise<DecisionPattern[]> {
      assertTenant(ctx, filter.companyId);
      const rows = await opts.db
        .select()
        .from(decisionPatterns)
        .where(
          and(
            eq(decisionPatterns.companyId, filter.companyId),
            isNull(decisionPatterns.supersededAt),
          ),
        )
        .orderBy(desc(decisionPatterns.derivedAt))
        .limit(filter.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        conditionSummary: r.conditionSummary,
        typicalChoice: r.typicalChoice,
        exemplarDecisionIds: r.exemplarDecisionIds ?? [],
        clusterSize: r.clusterSize,
        derivedAt: r.derivedAt,
        confidence: r.confidence,
        supersededAt: r.supersededAt,
        supersededById: r.supersededById,
      }));
    },

    async suggestPlaybooks(ctx, input): Promise<SuggestionResult[]> {
      assertTenant(ctx, input.companyId);
      const threshold = input.threshold ?? 0.3;
      const limit = input.limit ?? 3;

      // Fetch raw rows so we can read suggestedOutcomes without losing it in the
      // Playbook domain type (which deliberately omits the DB-only column).
      const rawRows = await opts.db
        .select()
        .from(playbooks)
        .where(
          and(
            eq(playbooks.companyId, input.companyId),
            eq(playbooks.status, "active"),
          ),
        )
        .orderBy(desc(playbooks.updatedAt))
        .limit(200);

      const scored: SuggestionResult[] = rawRows
        .map((row: typeof playbooks.$inferSelect) => {
          const pb = rowToPlaybook(row);
          const m = matchPlaybookApplicability(input.issueContext, pb);
          return {
            playbook: pb,
            score: m.score,
            reason: m.reason,
            suggestedOutcomesCount: ((row.suggestedOutcomes as unknown[]) ?? []).length,
          };
        })
        .filter((s: SuggestionResult) => s.score >= threshold)
        .sort((a: SuggestionResult, b: SuggestionResult) => b.score - a.score)
        .slice(0, limit);

      return scored;
    },

    async getSuggestedOutcomesForPlaybook(ctx, playbookId): Promise<unknown[] | null> {
      const [row] = await opts.db
        .select({
          id: playbooks.id,
          companyId: playbooks.companyId,
          suggestedOutcomes: playbooks.suggestedOutcomes,
        })
        .from(playbooks)
        .where(eq(playbooks.id, playbookId));
      if (!row) return null;
      assertTenant(ctx, row.companyId);
      return (row.suggestedOutcomes ?? []) as unknown[];
    },
  };
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function rowToPlaybook(row: typeof playbooks.$inferSelect): Playbook {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    title: row.title,
    slug: row.slug,
    status: row.status as PlaybookStatus,
    currentRevisionId: row.currentRevisionId,
    currentRevisionNumber: row.currentRevisionNumber,
    applicabilityConditions: row.applicabilityConditions as Playbook["applicabilityConditions"],
    sourceRunIds: row.sourceRunIds,
    sourcePlanIds: row.sourcePlanIds,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
    archivedAt: row.archivedAt,
  };
}

function rowToRevision(row: typeof playbookRevisions.$inferSelect): PlaybookRevision {
  return {
    id: row.id,
    playbookId: row.playbookId,
    revisionNumber: row.revisionNumber,
    parentRevisionId: row.parentRevisionId,
    contentMarkdown: row.contentMarkdown,
    changeSummary: row.changeSummary,
    createdAt: row.createdAt,
  };
}

let singleton: OrgLearningService | null = null;
export function initializeOrgLearningService(
  opts: OrgLearningServiceOpts,
): OrgLearningService {
  singleton = createOrgLearningService(opts);
  return singleton;
}
export function getOrgLearningService(): OrgLearningService {
  if (!singleton) {
    throw new Error("OrgLearningService not initialized — call initializeOrgLearningService at boot");
  }
  return singleton;
}
