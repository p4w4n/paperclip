import { and, eq } from "drizzle-orm";
import { outcomes, issueApprovals } from "@paperclipai/db";

export interface ApprovalEvidence {
  approvalId: string;
  companyId: string;
  approvalKind: string;
  decidedByUserId: string | null;
  decidedAt: Date;
}

import type { VerifiedRow } from "./artifact-declared.js";

export async function verifyApprovalGranted(
  db: any,
  evidence: ApprovalEvidence,
): Promise<{ verifiedCount: number; verifiedRows: VerifiedRow[] }> {
  // Look up which issues this approval is linked to via the join table.
  const links = await db.select({ issueId: issueApprovals.issueId })
    .from(issueApprovals)
    .where(eq(issueApprovals.approvalId, evidence.approvalId));
  if (links.length === 0) return { verifiedCount: 0, verifiedRows: [] };

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "approval_granted"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  const verifiedRows: VerifiedRow[] = [];
  for (const row of pending) {
    if (row.requiredMeta?.approval_kind !== evidence.approvalKind) continue;
    const matchesTarget = links.some((l: { issueId: string }) =>
      row.targetKind === "issue" && row.targetId === l.issueId
    );
    // Plan-level approval-granted is not Plan-1 (would need plan→issue join).
    if (!matchesTarget) continue;

    const verifiedMeta = {
      approval_id: evidence.approvalId,
      decided_by_user_id: evidence.decidedByUserId,
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
