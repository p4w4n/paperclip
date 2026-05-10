import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";
import { OUTCOME_KINDS, validateRequiredMeta, type OutcomeKind } from "@paperclipai/shared";
import { diffContract } from "./contract.js";
import { OutcomeRequiredError, type OutcomeTarget, type OutcomeRowLite } from "./types.js";

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
    // Validate every entry up front; reject the whole write if any one is invalid.
    for (const entry of desired) {
      if (!OUTCOME_KINDS.includes(entry.kind as OutcomeKind)) {
        throw new Error(`Unknown outcome kind: ${entry.kind}`);
      }
      const v = validateRequiredMeta(entry.kind as OutcomeKind, entry.requiredMeta);
      if (!v.ok) throw new Error(`Invalid required_meta for ${entry.kind}: ${v.errors.join("; ")}`);
    }

    return this.deps.db.transaction(async (tx: any) => {
      const existing: OutcomeRowLite[] = await tx
        .select()
        .from(outcomes)
        .where(and(
          eq(outcomes.companyId, target.companyId),
          eq(outcomes.targetKind, target.kind),
          eq(outcomes.targetId, target.id),
        ));

      const diff = diffContract(
        existing.map((e) => ({ id: e.id, kind: e.kind, requiredMeta: e.requiredMeta, status: e.status })),
        desired.map((d) => ({ kind: d.kind, requiredMeta: d.requiredMeta as { name: string } })),
      );

      let inserted = 0;
      for (const entry of diff.toInsert) {
        await tx.insert(outcomes).values({
          companyId: target.companyId,
          targetKind: target.kind,
          targetId: target.id,
          kind: entry.kind,
          status: "pending",
          requiredMeta: entry.requiredMeta,
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
    const result = await this.deps.db
      .update(outcomes)
      .set({ status: "reverted", revertedAt: new Date(), revertedReason: reason, updatedAt: new Date() })
      .where(and(eq(outcomes.id, outcomeId), eq(outcomes.status, "verified")))
      .returning();
    if (result.length === 0) throw new Error("Outcome not in verified state");
    return result[0];
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
