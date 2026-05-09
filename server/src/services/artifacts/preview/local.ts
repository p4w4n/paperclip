// Local preview provider — renders static kinds from the control
// plane. The URL it returns is a relative path served by the
// existing /preview/:artifactId/* route (A-7). The route
// resolves the artifact, then this provider's renderer reads the
// blob from storage and writes the response.
//
// Refused kinds: web.app (security). Returns supports=false so
// the registry falls through to the next provider; in Plan 1 there
// is no next provider, so web.app artifacts ship without a preview
// (UI shows "preview unavailable").

import { isKnownArtifactKind, ArtifactKindRegistry } from "@paperclipai/shared";
import type {
  PreviewMaterializeInput,
  PreviewMaterializeResult,
  PreviewProvider,
} from "./types.js";

export interface LocalProviderOpts {
  // Default TTL applied to the materialize result. Spec defaults
  // suggest 24h for web.app (when sandboxed), indefinite for
  // doc.markdown. Local provider is static so the TTL is mostly
  // bookkeeping — files don't expire from the storage layer here.
  defaultTtlMs?: number;
  // Public-facing URL prefix for /preview/...; defaults to relative.
  baseUrl?: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createLocalPreviewProvider(opts: LocalProviderOpts = {}): PreviewProvider {
  const ttlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, "") : "";
  return {
    id: "local",
    supports(kind) {
      if (!isKnownArtifactKind(kind)) return false;
      return ArtifactKindRegistry[kind].localPreviewable;
    },
    async materialize(input: PreviewMaterializeInput): Promise<PreviewMaterializeResult> {
      // The route at /preview/:artifactId/* is the actual renderer;
      // this provider just emits the URL + expiry. Blob fetch and
      // content-type-aware rendering happen at request time.
      return {
        url: `${base}/preview/${input.artifactId}/`,
        expiresAt: new Date(Date.now() + ttlMs),
      };
    },
    // Teardown is a no-op — local provider doesn't reserve external
    // resources. The reaper still calls it for symmetry.
    async teardown() {},
  };
}
