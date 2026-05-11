import { and, eq } from "drizzle-orm";
import { outcomes, issues, plans, playbooks } from "@paperclipai/db";
import { OUTCOME_KINDS, validateRequiredMeta, type OutcomeKind } from "@paperclipai/shared";
import { diffContract } from "./contract.js";
import { expandContractEntryToRows } from "./alias-resolver.js";
import { shouldReopenParent } from "./reopen-on-revert.js";
import { OutcomeRequiredError, type OutcomeTarget, type OutcomeRowLite } from "./types.js";
import { VERIFIERS, type VerifierKind } from "./verifiers/index.js";
import { verifyManualSignoff, type ManualSignoffInput } from "./verifiers/manual-signoff.js";
import { ingestExternalSignal, type SignalIngestInput } from "./verifiers/external-signal.js";
import { mergeSuggestedOutcomes, type MergeStrategy } from "./apply-suggested-outcomes.js";
import { matchPlaybookApplicability } from "../learning/applicability.js";
import {
  startMaterializeContractSpan,
  startTryVerifySpan,
  startRevertSpan,
  endSpanOk,
  endSpanError,
  SPAN_APPLY_PLAYBOOK,
  SPAN_AUTO_REOPEN,
} from "./spans.js";
import {
  recordVerified,
  recordReverted,
  recordVerifierError,
  recordSignalReceived,
  recordAutoReopen,
  recordAutoReopenFailed,
  recordAutoReopenSuppressed,
  recordPlaybookApplied,
} from "./metrics.js";
import { withSpan } from "../../observability/spans.js";
import { outcomesEvents } from "./events.js";

/** Low-cardinality bucket for added_count metric labels. */
function bucketize(n: number): "0" | "1" | "2-5" | "6+" {
  if (n === 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  return "6+";
}

export class PlaybookNotApplicableError extends Error {
  statusCode = 422;
  constructor(playbookId: string, issueId: string) {
    super(`Playbook ${playbookId} not applicable to issue ${issueId}`);
    this.name = "PlaybookNotApplicableError";
  }
}

interface OutcomesServiceDeps {
  // postgres-js / drizzle handle. Loose-typed because the ambient db type is
  // inferred from the host's connection layer; this service is consumed via
  // initializeOutcomesService at boot.
  db: any;
}

export class OutcomesService {
  constructor(private deps: OutcomesServiceDeps) {}

  async materializeContract(
    target: OutcomeTarget,
    desired: Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
  ): Promise<{ inserted: number; kept: number; pendingDeleted: number; droppedVerified: number }> {
    const span = startMaterializeContractSpan(target.kind, target.id);
    try {
      // Validate every entry up front; reject the whole write if any one is invalid.
      for (const entry of desired) {
        if (!OUTCOME_KINDS.includes(entry.kind as OutcomeKind)) {
          throw new Error(`Unknown outcome kind: ${entry.kind}`);
        }
        const v = validateRequiredMeta(entry.kind as OutcomeKind, entry.requiredMeta);
        if (!v.ok) throw new Error(`Invalid required_meta for ${entry.kind}: ${v.errors.join("; ")}`);
      }

      const result = await this.deps.db.transaction(async (tx: any) => {
        const existing: OutcomeRowLite[] = await tx
          .select()
          .from(outcomes)
          .where(and(
            eq(outcomes.companyId, target.companyId),
            eq(outcomes.targetKind, target.kind),
            eq(outcomes.targetId, target.id),
          ));

        // Expand each desired entry (primary + alternatives) before diffing so the
        // diff operates on individual rows keyed by (kind, name). Sibling alias rows
        // have distinct names by construction, so no collisions occur.
        const expandedDesired = desired.flatMap((d) =>
          expandContractEntryToRows(d as any).map((row) => ({
            kind: row.kind,
            requiredMeta: row.requiredMeta as { name: string; [k: string]: unknown },
          })),
        );

        const diff = diffContract(
          existing.map((e) => ({ id: e.id, kind: e.kind, requiredMeta: e.requiredMeta, status: e.status })),
          expandedDesired,
        );

        let inserted = 0;
        for (const row of diff.toInsert) {
          await tx.insert(outcomes).values({
            companyId: target.companyId,
            targetKind: target.kind,
            targetId: target.id,
            kind: row.kind,
            status: "pending",
            requiredMeta: row.requiredMeta,
          });
          inserted++;
        }

        let pendingDeleted = 0;
        for (const row of diff.pendingToDelete) {
          await tx.delete(outcomes).where(eq(outcomes.id, row.id));
          pendingDeleted++;
        }

        return {
          inserted,
          kept: diff.toKeep.length,
          pendingDeleted,
          droppedVerified: diff.droppedVerified.length,
        };
      });

      endSpanOk(span);
      return result;
    } catch (err) {
      endSpanError(span, err);
      throw err;
    }
  }

  async listForTarget(target: OutcomeTarget): Promise<OutcomeRowLite[]> {
    return this.deps.db
      .select()
      .from(outcomes)
      .where(and(
        eq(outcomes.companyId, target.companyId),
        eq(outcomes.targetKind, target.kind),
        eq(outcomes.targetId, target.id),
      ));
  }

  async revertOutcome(outcomeId: string, reason: string): Promise<OutcomeRowLite & {
    parentReopened: boolean;
    slotStillSatisfied: boolean;
  }> {
    const span = startRevertSpan(outcomeId);
    try {
      const result = await this.deps.db
        .update(outcomes)
        .set({ status: "reverted", revertedAt: new Date(), revertedReason: reason, updatedAt: new Date() })
        .where(and(eq(outcomes.id, outcomeId), eq(outcomes.status, "verified")))
        .returning();
      if (result.length === 0) throw new Error("Outcome not in verified state");

      const reverted: OutcomeRowLite = result[0];

      // Increment metric.
      recordReverted(reverted.kind, "operator");

      // EO-P2-11: After successful revert, evaluate slot + reopen (best-effort).
      let parentReopened = false;
      let slotStillSatisfied = false;
      try {
        await withSpan(
          SPAN_AUTO_REOPEN,
          async () => {
            // Load sibling rows for the same target.
            const allSiblings = await this.deps.db
              .select()
              .from(outcomes)
              .where(and(
                eq(outcomes.companyId, (reverted as any).companyId),
                eq(outcomes.targetKind, (reverted as any).targetKind),
                eq(outcomes.targetId, (reverted as any).targetId),
              ));
            const siblingsExceptSelf = allSiblings.filter((s: any) => s.id !== reverted.id);

            const decision = shouldReopenParent(reverted as any, siblingsExceptSelf as any);
            if (decision.reopen) {
              if ((reverted as any).targetKind === "issue") {
                await this.deps.db
                  .update(issues)
                  .set({ status: "in_progress", completedAt: null, updatedAt: new Date() })
                  .where(eq(issues.id, (reverted as any).targetId));
              } else {
                await this.deps.db
                  .update(plans)
                  .set({ status: "in_progress", completedAt: null, updatedAt: new Date() })
                  .where(eq(plans.id, (reverted as any).targetId));
              }
              parentReopened = true;
              recordAutoReopen({ kind: reverted.kind, target_kind: (reverted as any).targetKind });
            } else if ((decision as any).reason === "alt_covers") {
              slotStillSatisfied = true;
              recordAutoReopenSuppressed({ reason: "alt_covers" });
            }
          },
          {
            "outcome.id": outcomeId,
            "outcome.kind": reverted.kind,
            "outcome.target_kind": (reverted as any).targetKind ?? "unknown",
          },
        );
      } catch (err) {
        recordAutoReopenFailed({
          kind: reverted.kind,
          target_kind: (reverted as any).targetKind,
          reason_class: "exception",
        });
        console.error("[outcomes] auto-reopen failed (best-effort)", { outcomeId, err });
        // Best-effort: revert still succeeds.
      }

      outcomesEvents.emit("reverted", {
        outcomeId: reverted.id,
        kind: reverted.kind,
        targetKind: (reverted as any).targetKind ?? "unknown",
        targetId: (reverted as any).targetId ?? outcomeId,
        companyId: (reverted as any).companyId ?? "",
        reason,
        parentReopened,
      });

      endSpanOk(span);
      return { ...reverted, parentReopened, slotStillSatisfied };
    } catch (err) {
      endSpanError(span, err);
      throw err;
    }
  }

  async tryVerify<K extends VerifierKind>(
    kind: K,
    evidence: Parameters<typeof VERIFIERS[K]>[1],
  ): Promise<{ verifiedCount: number }> {
    const verifier = VERIFIERS[kind];
    if (!verifier) return { verifiedCount: 0 };
    const span = startTryVerifySpan(kind);
    try {
      const result = await verifier(this.deps.db, evidence as any);
      const { verifiedCount, verifiedRows } = result as {
        verifiedCount: number;
        verifiedRows?: Array<{
          id: string;
          kind: string;
          targetKind: string;
          targetId: string;
          companyId: string;
          verifiedMeta?: unknown;
        }>;
      };

      if (verifiedCount > 0) {
        recordVerified(kind);
        for (const row of verifiedRows ?? []) {
          outcomesEvents.emit("verified", {
            kind: row.kind,
            targetKind: row.targetKind,
            targetId: row.targetId,
            companyId: row.companyId,
            verifiedMeta: row.verifiedMeta,
          });
        }
      }

      endSpanOk(span);
      return { verifiedCount };
    } catch (err) {
      // Best-effort — log, don't bubble to source service.
      console.error("[outcomes] verifier error", { kind, err });
      recordVerifierError(kind);
      endSpanError(span, err);
      return { verifiedCount: 0 };
    }
  }

  async signOff(input: ManualSignoffInput) {
    const result = await verifyManualSignoff(this.deps.db, input);
    if (result.verifiedCount > 0) {
      recordVerified("manual_signoff");
      // Fetch the row to get targetKind/targetId for the event.
      const rows = await this.deps.db
        .select()
        .from(outcomes)
        .where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.companyId, input.companyId)));
      if (rows.length > 0) {
        const row = rows[0];
        outcomesEvents.emit("verified", {
          kind: row.kind,
          targetKind: row.targetKind,
          targetId: row.targetId,
          companyId: row.companyId,
          verifiedMeta: row.verifiedMeta,
        });
      }
    }
    return result;
  }

  async ingestSignal(input: SignalIngestInput) {
    const result = await ingestExternalSignal(this.deps.db, input);
    recordSignalReceived(result.verified);
    if (result.verified && !result.replay) {
      // Fetch the row to get targetKind/targetId for the event.
      const rows = await this.deps.db
        .select()
        .from(outcomes)
        .where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.companyId, input.companyId)));
      if (rows.length > 0) {
        const row = rows[0];
        outcomesEvents.emit("verified", {
          kind: row.kind,
          targetKind: row.targetKind,
          targetId: row.targetId,
          companyId: row.companyId,
          verifiedMeta: row.verifiedMeta,
        });
      }
    }
    return result;
  }

  /**
   * Operator-driven: apply a playbook's suggested_outcomes to an issue.
   *
   * @param applicabilityScore - Optional override for the applicability score.
   *   When provided, skips the live DB-based applicability lookup and uses this
   *   value directly. Primary use-case: in-process tests that cannot easily stub
   *   matchPlaybookApplicability because it requires a real Playbook row with
   *   applicabilityConditions. Pass undefined (or omit) in production to
   *   perform a real applicability check using the playbook's full DB row.
   */
  async applyPlaybookToIssue(
    ctx: { callerCompanyId: string },
    issueId: string,
    playbookId: string,
    mergeStrategy: MergeStrategy = "skip_existing",
    applicabilityScore?: number,
  ): Promise<{
    addedOutcomes: Array<{ kind: string; name: string }>;
    skippedExisting: Array<{ kind: string; name: string }>;
    newContractLength: number;
  }> {
    // Load issue + tenant-check.
    const [issue] = await this.deps.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!issue) throw new Error(`issue not found: ${issueId}`);
    if (issue.companyId !== ctx.callerCompanyId) throw new Error("Outcome tenant mismatch");

    // Load playbook row (needed for applicability check + suggested_outcomes).
    const [playbookRow] = await this.deps.db
      .select()
      .from(playbooks)
      .where(eq(playbooks.id, playbookId));
    if (!playbookRow) throw new Error(`playbook not found: ${playbookId}`);
    if (playbookRow.companyId !== ctx.callerCompanyId) throw new Error("Playbook tenant mismatch");

    // Applicability gate.
    // If applicabilityScore is provided (test override), use it directly.
    // Otherwise run matchPlaybookApplicability against the issue title/labels.
    const score =
      applicabilityScore !== undefined
        ? applicabilityScore
        : matchPlaybookApplicability(
            {
              title: (issue as any).title ?? "",
              labels: (issue as any).labels ?? [],
              projectId: (issue as any).projectId ?? undefined,
              assigneeAgentId: (issue as any).assigneeAgentId ?? undefined,
            },
            {
              id: playbookRow.id,
              companyId: playbookRow.companyId,
              agentId: playbookRow.agentId,
              title: playbookRow.title,
              slug: playbookRow.slug,
              status: playbookRow.status as any,
              currentRevisionId: playbookRow.currentRevisionId,
              currentRevisionNumber: playbookRow.currentRevisionNumber,
              applicabilityConditions: playbookRow.applicabilityConditions as any,
              sourceRunIds: playbookRow.sourceRunIds,
              sourcePlanIds: playbookRow.sourcePlanIds,
              confidence: playbookRow.confidence,
              createdAt: playbookRow.createdAt,
              updatedAt: playbookRow.updatedAt,
              approvedAt: playbookRow.approvedAt,
              archivedAt: playbookRow.archivedAt,
            },
          ).score;

    if (score === 0) {
      throw new PlaybookNotApplicableError(playbookId, issueId);
    }

    const suggested = (playbookRow.suggestedOutcomes ?? []) as Array<{
      kind: string;
      requiredMeta: { name: string; [k: string]: unknown };
    }>;

    const existing = (issue.requiredOutcomes ?? []) as Array<{
      kind: string;
      requiredMeta: { name: string; [k: string]: unknown };
    }>;

    const merge = mergeSuggestedOutcomes(existing as any, suggested as any, mergeStrategy);

    return withSpan(
      SPAN_APPLY_PLAYBOOK,
      async () => {
        // Materialize into outcomes rows (expands alternatives via EO-P2-10).
        await this.materializeContract(
          { kind: "issue", id: issue.id, companyId: issue.companyId },
          merge.merged as Array<{ kind: string; requiredMeta: Record<string, unknown> }>,
        );

        // Persist requiredOutcomes column on the issue (EO-P1 lesson: column write must not be omitted).
        await this.deps.db
          .update(issues)
          .set({ requiredOutcomes: merge.merged as unknown[] })
          .where(eq(issues.id, issue.id));

        recordPlaybookApplied({
          playbook_id_low_card: playbookId.slice(0, 8),
          added_count_bucket: bucketize(merge.added.length),
        });

        return {
          addedOutcomes: merge.added,
          skippedExisting: merge.skippedExisting,
          newContractLength: merge.merged.length,
        };
      },
      {
        "outcome.playbook_id": playbookId,
        "outcome.issue_id": issueId,
        "outcome.added_count": merge.added.length,
      },
    );
  }
}

let singleton: OutcomesService | null = null;

export function initializeOutcomesService(deps: OutcomesServiceDeps): OutcomesService {
  singleton = new OutcomesService(deps);
  return singleton;
}

export function getOutcomesService(): OutcomesService {
  if (!singleton) throw new Error("OutcomesService not initialized — call initializeOutcomesService at boot");
  return singleton;
}

export { OutcomeRequiredError };
