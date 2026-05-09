import type { ArtifactKindDefinition } from "./types.js";

// web.app — deployable bundle. Local provider explicitly refuses
// to render (security: don't run untrusted code on the control
// plane). e2b / Cloudflare providers in Plan 2 handle the safe-
// preview surface.
//
// content_meta required:
//   - entry: string (relative path to index.html or server entry)
// Optional:
//   - framework: 'react'|'vue'|'svelte'|'static'|'next'|'remix'
//   - port: number (for non-static apps)
export const webAppKind: ArtifactKindDefinition = {
  id: "web.app",
  displayName: "Web app",
  contentTypes: ["application/zip", "application/x-tar"],
  localPreviewable: false,
  validateMeta(meta) {
    if (meta == null || typeof meta !== "object") {
      return ["content_meta is required for web.app"];
    }
    const m = meta as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof m.entry !== "string" || m.entry.trim().length === 0) {
      errors.push("entry is required");
    }
    if ("port" in m && typeof m.port !== "number") {
      errors.push("port must be a number");
    }
    return errors;
  },
};
