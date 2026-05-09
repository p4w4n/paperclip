// Pluggable preview provider contract.
//
// Plan 1: one provider — `local`. Renders static kinds (code.file,
// code.patch, doc.markdown, chart, data.table) from the control
// plane via the existing storage layer; explicitly refuses
// web.app (security: don't run untrusted code in-process; that's
// the e2b / Cloudflare provider's job in Plan 2).

export interface PreviewMaterializeInput {
  artifactId: string;
  blobStorageKey: string;
  kind: string;
  contentType: string;
  companyId: string;
}

export interface PreviewMaterializeResult {
  url: string;
  expiresAt: Date;
}

export interface PreviewProvider {
  id: string;
  // Whether this provider can handle this kind. Registry resolves
  // kind → first provider returning true.
  supports(kind: string): boolean;
  materialize(input: PreviewMaterializeInput): Promise<PreviewMaterializeResult>;
  // Optional explicit teardown (called by the reaper). Local
  // provider's previews don't reserve external resources so its
  // teardown is a no-op; sandboxed providers (e2b/Cloudflare) tear
  // down the microvm.
  teardown?(input: { artifactId: string }): Promise<void>;
}
