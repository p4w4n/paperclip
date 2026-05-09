// Shared types for the artifact-kinds registry. Each kind module
// exports a definition matching this shape; the registry is just a
// frozen Record<id, definition>.

export interface ArtifactKindDefinition {
  id: string;
  displayName: string;
  // Allowed content types. UI can hint based on these; the server
  // doesn't enforce strict matching (mime sniffing is fragile).
  contentTypes: readonly string[];
  // Validate the kind-specific JSON metadata. Returns an array of
  // error messages — empty when valid. Pure function; no I/O.
  validateMeta(meta: unknown): string[];
  // Whether the local preview provider can render this kind. Drives
  // the "preview pending vs unavailable" UI affordance.
  localPreviewable: boolean;
}

export type ArtifactKindId =
  | "code.file"
  | "code.patch"
  | "doc.markdown"
  | "doc.office"
  | "chart"
  | "data.table"
  | "web.app";
