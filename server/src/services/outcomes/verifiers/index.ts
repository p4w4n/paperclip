import { verifyArtifactDeclared } from "./artifact-declared.js";

export { verifyArtifactDeclared, type ArtifactEvidence } from "./artifact-declared.js";

export const VERIFIERS = {
  artifact_declared: verifyArtifactDeclared,
  // additional verifiers added in subsequent tasks (EO-8 / EO-9)
} as const;

export type VerifierKind = keyof typeof VERIFIERS;
