import { describe, expect, it } from "vitest";
import { createLocalPreviewProvider } from "../local.js";

describe("local preview provider", () => {
  it("supports kinds where ArtifactKindRegistry.localPreviewable is true", () => {
    const p = createLocalPreviewProvider();
    expect(p.supports("code.file")).toBe(true);
    expect(p.supports("doc.markdown")).toBe(true);
    expect(p.supports("chart")).toBe(true);
    expect(p.supports("data.table")).toBe(true);
  });

  it("refuses web.app and unknown kinds", () => {
    const p = createLocalPreviewProvider();
    expect(p.supports("web.app")).toBe(false);
    expect(p.supports("nonsense")).toBe(false);
  });

  it("materialize returns a URL + future expiry", async () => {
    const p = createLocalPreviewProvider();
    const before = Date.now();
    const out = await p.materialize({
      artifactId: "art-1",
      blobStorageKey: "x",
      kind: "code.file",
      contentType: "text/plain",
      companyId: "co-1",
    });
    expect(out.url).toContain("/preview/art-1/");
    expect(out.expiresAt.getTime()).toBeGreaterThan(before);
  });

  it("respects baseUrl prefix", async () => {
    const p = createLocalPreviewProvider({ baseUrl: "https://app.paperclip.ai" });
    const out = await p.materialize({
      artifactId: "art-1",
      blobStorageKey: "x",
      kind: "doc.markdown",
      contentType: "text/markdown",
      companyId: "co-1",
    });
    expect(out.url).toBe("https://app.paperclip.ai/preview/art-1/");
  });
});
