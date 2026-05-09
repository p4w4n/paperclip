// Pure helpers for the plan-revision chain.
//
// All operate on rows already loaded from the DB (the service
// builds the row list once and passes it here). Mirrors the
// pattern memory-pages and document-revisions use.

export interface RevisionLike {
  id: string;
  revisionNumber: number;
  contentMarkdown: string;
  parentRevisionId: string | null;
  createdAt: Date | string;
}

export function nextRevisionNumber(rows: ReadonlyArray<RevisionLike>): number {
  if (rows.length === 0) return 1;
  return Math.max(...rows.map((r) => r.revisionNumber)) + 1;
}

export function currentRevision<T extends RevisionLike>(
  rows: ReadonlyArray<T>,
): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
}

/**
 * Line-level diff between two revisions. Output is markdown
 * fenced as a unified-diff-ish block; the UI renders verbatim.
 */
export function revisionDiff(prev: string | null, next: string): string {
  const prevLines = (prev ?? "").split("\n");
  const nextLines = next.split("\n");
  const out: string[] = [];
  // Naive diff — for production v1 a proper LCS-based diff would
  // land on the UI side via diff-md. Here we just call out adds
  // and removes by line position so the helper is testable + cheap.
  const max = Math.max(prevLines.length, nextLines.length);
  for (let i = 0; i < max; i++) {
    const a = prevLines[i];
    const b = nextLines[i];
    if (a === b) {
      if (a !== undefined) out.push(`  ${a}`);
      continue;
    }
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.join("\n");
}
