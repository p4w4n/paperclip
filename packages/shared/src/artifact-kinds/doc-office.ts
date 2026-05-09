import type { ArtifactKindDefinition } from "./types.js";

// doc.office — Word / Excel / PowerPoint. Binary blob; no inline
// preview, just download. content_meta optional:
//   - format: 'docx'|'xlsx'|'pptx'
//   - page_count: number
export const docOfficeKind: ArtifactKindDefinition = {
  id: "doc.office",
  displayName: "Office doc",
  contentTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  localPreviewable: false,
  validateMeta(meta) {
    if (meta == null) return [];
    if (typeof meta !== "object") return ["content_meta must be an object"];
    const m = meta as Record<string, unknown>;
    const errors: string[] = [];
    if ("format" in m) {
      if (typeof m.format !== "string" || !["docx", "xlsx", "pptx"].includes(m.format)) {
        errors.push("format must be one of docx|xlsx|pptx");
      }
    }
    if ("page_count" in m && typeof m.page_count !== "number") {
      errors.push("page_count must be a number");
    }
    return errors;
  },
};
