import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

export interface DecisionEvidence {
  decisionId: string;
  companyId: string;
  planId: string;
  planIssueId: string | null;
  title: string;            // matches existing plan_decisions.title column
  chosenOptionId: string | null;
  decidedAt: Date;
}

import type { VerifiedRow } from "./artifact-declared.js";

export async function verifyDecisionRecorded(
  db: any,
  evidence: DecisionEvidence,
): Promise<{ verifiedCount: number; verifiedRows: VerifiedRow[] }> {
  // Gate: only verify once a chosen option exists (decision actually made).
  if (!evidence.chosenOptionId) return { verifiedCount: 0, verifiedRows: [] };

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "decision_recorded"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  const verifiedRows: VerifiedRow[] = [];
  for (const row of pending) {
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.planIssueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;
    if (row.requiredMeta?.plan_id !== evidence.planId) continue;
    if (row.requiredMeta?.decision_title !== evidence.title) continue;

    const verifiedMeta = {
      decision_id: evidence.decisionId,
      chosen_option_id: evidence.chosenOptionId,
      decided_at: evidence.decidedAt.toISOString(),
    };
    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta,
      verifiedAt: new Date(),
      verifiedByKind: "system",
      updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) {
      verifiedCount++;
      verifiedRows.push({
        id: row.id,
        kind: row.kind,
        targetKind: row.targetKind,
        targetId: row.targetId,
        companyId: row.companyId,
        verifiedMeta,
      });
    }
  }
  return { verifiedCount, verifiedRows };
}
