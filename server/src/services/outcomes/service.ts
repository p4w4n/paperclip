import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";
import { OUTCOME_KINDS, validateRequiredMeta, type OutcomeKind } from "@paperclipai/shared";
import { diffContract } from "./contract.js";
import { expandContractEntryToRows } from "./alias-resolver.js";
import { OutcomeRequiredError, type OutcomeTarget, type OutcomeRowLite } from "./types.js";
import { VERIFIERS, type VerifierKind } from "./verifiers/index.js";
import { verifyManualSignoff, type ManualSignoffInput } from "./verifiers/manual-signoff.js";
import { ingestExternalSignal, type SignalIngestInput } from "./verifiers/external-signal.js";
import {
  startMaterializeContractSpan,
  startTryVerifySpan,
  startRevertSpan,
  endSpanOk,
  endSpanError,
} from "./spans.js";
import {
  recordVerified,
  recordReverted,
  recordVerifierError,
  recordSignalReceived,
} from "./metrics.js";
import { outcomesEvents } from "./events.js";

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

  async revertOutcome(outcomeId: string, reason: string): Promise<OutcomeRowLite> {
    const span = startRevertSpan(outcomeId);
    try {
      const result = await this.deps.db
        .update(outcomes)
        .set({ status: "reverted", revertedAt: new Date(), revertedReason: reason, updatedAt: new Date() })
        .where(and(eq(outcomes.id, outcomeId), eq(outcomes.status, "verified")))
        .returning();
      if (result.length === 0) throw new Error("Outcome not in verified state");

      const row: OutcomeRowLite = result[0];

      // Increment metric + emit event.
      recordReverted(row.kind, "operator");
      outcomesEvents.emit("reverted", {
        kind: row.kind,
        targetKind: (row as any).targetKind ?? "unknown",
        targetId: (row as any).targetId ?? outcomeId,
        companyId: (row as any).companyId ?? "",
        reason,
      });

      endSpanOk(span);
      return row;
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
