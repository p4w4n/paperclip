import type { ArtifactKindDefinition } from "./types.js";

// code.patch — unified diff. content_meta required fields:
//   - target_ref: string (branch / commit the patch applies against)
// Optional:
//   - files_changed: number
//   - additions: number
//   - deletions: number
export const codePatchKind: ArtifactKindDefinition = {
  id: "code.patch",
  displayName: "Code patch",
  contentTypes: ["text/x-diff", "text/x-patch", "text/plain"],
  localPreviewable: true,
  validateMeta(meta) {
    const errors: string[] = [];
    if (meta == null || typeof meta !== "object") {
      return ["content_meta is required for code.patch"];
    }
    const m = meta as Record<string, unknown>;
    if (typeof m.target_ref !== "string" || m.target_ref.trim().length === 0) {
      errors.push("content_meta.target_ref is required");
    }
    for (const key of ["files_changed", "additions", "deletions"]) {
      if (key in m && typeof m[key] !== "number") {
        errors.push(`content_meta.${key} must be a number`);
      }
    }
    return errors;
  },
};
