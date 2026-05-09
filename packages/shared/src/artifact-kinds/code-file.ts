import type { ArtifactKindDefinition } from "./types.js";

// code.file — full file snapshot. Path lives in artifact.name.
// content_meta optional fields:
//   - language: string (hint for syntax highlighting)
//   - line_count: number (UI summary; server doesn't recompute)
export const codeFileKind: ArtifactKindDefinition = {
  id: "code.file",
  displayName: "Code file",
  contentTypes: ["text/plain", "text/x-typescript", "text/x-javascript", "text/x-python"],
  localPreviewable: true,
  validateMeta(meta) {
    const errors: string[] = [];
    if (meta == null) return errors;
    if (typeof meta !== "object") {
      return ["content_meta must be an object"];
    }
    const m = meta as Record<string, unknown>;
    if ("language" in m && typeof m.language !== "string") {
      errors.push("content_meta.language must be a string");
    }
    if ("line_count" in m && typeof m.line_count !== "number") {
      errors.push("content_meta.line_count must be a number");
    }
    return errors;
  },
};
