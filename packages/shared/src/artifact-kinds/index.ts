// Artifact-kind registry. Plugins register additional kinds via
// the same shape (Plan 2 surface).

import { chartKind } from "./chart.js";
import { codeFileKind } from "./code-file.js";
import { codePatchKind } from "./code-patch.js";
import { dataTableKind } from "./data-table.js";
import { docMarkdownKind } from "./doc-markdown.js";
import { docOfficeKind } from "./doc-office.js";
import type { ArtifactKindDefinition } from "./types.js";
import { webAppKind } from "./web-app.js";

export type { ArtifactKindDefinition, ArtifactKindId } from "./types.js";

const definitions: readonly ArtifactKindDefinition[] = [
  codeFileKind,
  codePatchKind,
  docMarkdownKind,
  docOfficeKind,
  chartKind,
  dataTableKind,
  webAppKind,
];

export const ArtifactKindRegistry = Object.freeze(
  Object.fromEntries(definitions.map((d) => [d.id, d])) as Record<
    string,
    ArtifactKindDefinition
  >,
);

export function isKnownArtifactKind(kind: string): boolean {
  return kind in ArtifactKindRegistry;
}

export function validateContentMeta(
  kind: string,
  meta: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const def = ArtifactKindRegistry[kind];
  if (!def) {
    return { ok: false, errors: [`unknown artifact kind: ${kind}`] };
  }
  const errors = def.validateMeta(meta);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
