import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

export interface PlanCompletedEvidence {
  planId: string;
  companyId: string;
  issueId: string | null;     // plans.issue_id (nullable per existing schema)
  completedAt: Date;
  revisionId: string | null;
}

export async function verifyPlanCompleted(db: any, evidence: PlanCompletedEvidence): Promise<{ verifiedCount: number }> {
  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "plan_completed"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  for (const row of pending) {
    // Target match: issue (plan's issue_id) OR plan (direct id match).
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.issueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;

    const requiredPlanId: string | undefined = row.requiredMeta?.plan_id;
    if (requiredPlanId && requiredPlanId !== evidence.planId) continue;

    const result = await db.update(outcomes).set({
      status: "verified",
      verifiedMeta: {
        plan_id: evidence.planId,
        completed_at: evidence.completedAt.toISOString(),
        revision_id: evidence.revisionId,
      },
      verifiedAt: new Date(),
      verifiedByKind: "system",
      updatedAt: new Date(),
    }).where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending"))).returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}
