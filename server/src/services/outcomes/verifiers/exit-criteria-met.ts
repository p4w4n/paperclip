import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";
import { parseCheckboxes } from "../checkbox-parser.js";

export interface PhaseEvidence {
  planPhaseId: string;
  companyId: string;
  planId: string;
  planIssueId: string | null;
  exitCriteriaMarkdown: string;
}

import type { VerifiedRow } from "./artifact-declared.js";

export async function verifyExitCriteriaMet(
  db: any,
  evidence: PhaseEvidence,
): Promise<{ verifiedCount: number; verifiedRows: VerifiedRow[] }> {
  const parsed = parseCheckboxes(evidence.exitCriteriaMarkdown);
  if (!parsed.allChecked) return { verifiedCount: 0, verifiedRows: [] };

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, evidence.companyId),
    eq(outcomes.kind, "exit_criteria_met"),
    eq(outcomes.status, "pending"),
  ));

  let verifiedCount = 0;
  const verifiedRows: VerifiedRow[] = [];
  for (const row of pending) {
    if (row.requiredMeta?.plan_phase_id !== evidence.planPhaseId) continue;
    const targetMatch =
      (row.targetKind === "issue" && row.targetId === evidence.planIssueId) ||
      (row.targetKind === "plan" && row.targetId === evidence.planId);
    if (!targetMatch) continue;

    const verifiedMeta = {
      checked_count: parsed.checked,
      total_count: parsed.total,
      parsed_at: new Date().toISOString(),
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
