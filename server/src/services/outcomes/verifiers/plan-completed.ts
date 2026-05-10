import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

export interface PlanCompletedEvidence {
  planId: string;
  companyId: string;
  issueId: string | null;     // plans.issue_id (nullable per existing schema)
  completedAt: Date;
  revisionId: string | null;
}

import type { VerifiedRow } from "./artifact-declared.js";

export async function verifyPlanCompleted(
  db: any,
  evidence: PlanCompletedEvidence,
): Promise<{ verifiedCount: number; verifiedRows: VerifiedRow[] }> {
  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "plan_completed"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  const verifiedRows: VerifiedRow[] = [];
  for (const row of pending) {
    // Target match: issue (plan's issue_id) OR plan (direct id match).
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.issueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;

    const requiredPlanId: string | undefined = row.requiredMeta?.plan_id;
    if (requiredPlanId && requiredPlanId !== evidence.planId) continue;

    const verifiedMeta = {
      plan_id: evidence.planId,
      completed_at: evidence.completedAt.toISOString(),
      revision_id: evidence.revisionId,
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
