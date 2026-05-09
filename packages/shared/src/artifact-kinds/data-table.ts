import type { ArtifactKindDefinition } from "./types.js";

// data.table — tabular data. CSV or JSON-rows. content_meta optional:
//   - row_count: number
//   - columns: string[]
//   - format: 'csv'|'json'
export const dataTableKind: ArtifactKindDefinition = {
  id: "data.table",
  displayName: "Data table",
  contentTypes: ["text/csv", "application/json"],
  localPreviewable: true,
  validateMeta(meta) {
    if (meta == null) return [];
    if (typeof meta !== "object") return ["content_meta must be an object"];
    const m = meta as Record<string, unknown>;
    const errors: string[] = [];
    if ("row_count" in m && typeof m.row_count !== "number") {
      errors.push("row_count must be a number");
    }
    if ("columns" in m) {
      if (!Array.isArray(m.columns) || !m.columns.every((c) => typeof c === "string")) {
        errors.push("columns must be string[]");
      }
    }
    if ("format" in m) {
      if (typeof m.format !== "string" || !["csv", "json"].includes(m.format)) {
        errors.push("format must be csv|json");
      }
    }
    return errors;
  },
};
