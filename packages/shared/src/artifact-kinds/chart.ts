import type { ArtifactKindDefinition } from "./types.js";

// chart — data visualization. Either an SVG payload or a vega-lite
// JSON spec. content_meta optional:
//   - title: string
//   - format: 'svg'|'vega-lite'
export const chartKind: ArtifactKindDefinition = {
  id: "chart",
  displayName: "Chart",
  contentTypes: ["image/svg+xml", "application/json"],
  localPreviewable: true,
  validateMeta(meta) {
    if (meta == null) return [];
    if (typeof meta !== "object") return ["content_meta must be an object"];
    const m = meta as Record<string, unknown>;
    const errors: string[] = [];
    if ("title" in m && typeof m.title !== "string") errors.push("title must be a string");
    if ("format" in m) {
      if (typeof m.format !== "string" || !["svg", "vega-lite"].includes(m.format)) {
        errors.push("format must be one of svg|vega-lite");
      }
    }
    return errors;
  },
};
