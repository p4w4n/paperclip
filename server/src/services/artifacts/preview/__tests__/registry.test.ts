import { afterEach, describe, expect, it } from "vitest";
import { createLocalPreviewProvider } from "../local.js";
import {
  clearPreviewProviders,
  getPreviewProviderById,
  getPreviewProviderForKind,
  registerPreviewProvider,
} from "../registry.js";

afterEach(() => {
  clearPreviewProviders();
});

describe("preview registry", () => {
  it("resolves kind via first matching provider", () => {
    registerPreviewProvider(createLocalPreviewProvider());
    expect(getPreviewProviderForKind("code.file")?.id).toBe("local");
    expect(getPreviewProviderForKind("web.app")).toBeNull();
  });

  it("can resolve provider by id", () => {
    registerPreviewProvider(createLocalPreviewProvider());
    expect(getPreviewProviderById("local")?.id).toBe("local");
    expect(getPreviewProviderById("ghost")).toBeNull();
  });

  it("re-register replaces by id", () => {
    registerPreviewProvider(createLocalPreviewProvider());
    registerPreviewProvider(createLocalPreviewProvider({ baseUrl: "https://x" }));
    // Only one provider with id=local registered.
    const p = getPreviewProviderById("local");
    expect(p).not.toBeNull();
  });
});
