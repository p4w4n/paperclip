import type { ArtifactKindDefinition } from "./types.js";

// doc.markdown — markdown document. Optional content_meta:
//   - title: string
//   - word_count: number
//   - document_revision_id: string (link into existing
//     document_revisions row when present; Plan 2 consolidates).
export const docMarkdownKind: ArtifactKindDefinition = {
  id: "doc.markdown",
  displayName: "Markdown doc",
  contentTypes: ["text/markdown", "text/x-markdown"],
  localPreviewable: true,
  validateMeta(meta) {
    if (meta == null) return [];
    if (typeof meta !== "object") return ["content_meta must be an object"];
    const m = meta as Record<string, unknown>;
    const errors: string[] = [];
    if ("title" in m && typeof m.title !== "string") errors.push("title must be a string");
    if ("word_count" in m && typeof m.word_count !== "number") {
      errors.push("word_count must be a number");
    }
    if ("document_revision_id" in m && typeof m.document_revision_id !== "string") {
      errors.push("document_revision_id must be a string");
    }
    return errors;
  },
};
