// Run-summary integration: when a heartbeat run finishes, callers
// can pull the run's declared artifacts and render a "Work products"
// section to append to the summary text.
//
// Pure-output: takes a list of declared artifacts, returns a
// markdown snippet. Empty list → null (caller decides whether to
// skip the section entirely).
//
// Wiring into heartbeat-run-summary.ts is left to the caller —
// the summary builder there already rolls up summary/result/message
// into the result_json. Adding a "work_products" key (per-row
// {kind, name, id}) is the cleanest hand-off; UI renders it.

import type { DeclaredArtifact } from "./types.js";

export interface ArtifactSummaryRow {
  id: string;
  kind: string;
  name: string;
  previewUrl: string | null;
}

export function buildArtifactsSummarySection(
  artifacts: ArtifactSummaryRow[],
): string | null {
  if (artifacts.length === 0) return null;
  const lines = ["## Work products"];
  for (const a of artifacts) {
    const previewSuffix = a.previewUrl ? ` — [preview](${a.previewUrl})` : "";
    lines.push(`- **${a.kind}** \`${a.name}\`${previewSuffix}`);
  }
  return lines.join("\n");
}

export function declaredToSummaryRow(a: DeclaredArtifact): ArtifactSummaryRow {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    previewUrl: a.previewUrl,
  };
}
