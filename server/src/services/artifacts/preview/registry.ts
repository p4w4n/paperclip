// Preview-provider registry. Resolves kind → first provider that
// supports it; falls through to null when none does (UI shows
// "preview unavailable").
//
// Plan 1 only registers the local provider. Plan 2 adds e2b +
// Cloudflare which take precedence for web.app and live kinds.

import type { PreviewProvider } from "./types.js";

let providers: PreviewProvider[] = [];

export function registerPreviewProvider(provider: PreviewProvider): void {
  providers = [...providers.filter((p) => p.id !== provider.id), provider];
}

export function getPreviewProviderForKind(kind: string): PreviewProvider | null {
  return providers.find((p) => p.supports(kind)) ?? null;
}

export function getPreviewProviderById(id: string): PreviewProvider | null {
  return providers.find((p) => p.id === id) ?? null;
}

export function clearPreviewProviders(): void {
  // Test-only.
  providers = [];
}
