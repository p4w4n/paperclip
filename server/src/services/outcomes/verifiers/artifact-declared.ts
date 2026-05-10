import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

export interface ArtifactEvidence {
  id: string;          // artifact id
  companyId: string;
  issueId: string | null;
  kind: string;        // e.g., "code.patch"
  name: string;
  blobSha256: string;
  declaredAt: Date;
  /** When target_kind=plan, the plan row's issue_id; populated by caller. */
  planTargetIssueId?: string | null;
}

export async function verifyArtifactDeclared(db: any, evidence: ArtifactEvidence): Promise<{ verifiedCount: number }> {
  // Look up all pending artifact_declared outcomes in this company.
  const pending = await db
    .select()
    .from(outcomes)
    .where(and(
      eq(outcomes.companyId, evidence.companyId),
      eq(outcomes.kind, "artifact_declared"),
      eq(outcomes.status, "pending"),
    ));

  let verifiedCount = 0;
  for (const row of pending) {
    if (!matches(row, evidence)) continue;
    const result = await db
      .update(outcomes)
      .set({
        status: "verified",
        verifiedMeta: {
          artifact_id: evidence.id,
          blob_sha256: evidence.blobSha256,
          declared_at: evidence.declaredAt.toISOString(),
        },
        verifiedAt: new Date(),
        verifiedByKind: "system",
        updatedAt: new Date(),
      })
      .where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending")))
      .returning();
    if (result.length > 0) verifiedCount++;
  }
  return { verifiedCount };
}

function matches(row: any, e: ArtifactEvidence): boolean {
  // target match
  if (row.targetKind === "issue") {
    if (row.targetId !== e.issueId) return false;
  } else if (row.targetKind === "plan") {
    if (e.planTargetIssueId == null) return false;
    if (row.targetId !== e.planTargetIssueId) return false;
  } else {
    return false;
  }
  // kind match
  if (row.requiredMeta?.artifact_kind !== e.kind) return false;
  // name match: glob OR exact
  const glob: string | undefined = row.requiredMeta?.name_glob;
  const requiredName: string = row.requiredMeta?.name;
  if (glob) {
    return globMatch(glob, e.name);
  }
  return requiredName === e.name;
}

function globMatch(glob: string, str: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(str);
}
