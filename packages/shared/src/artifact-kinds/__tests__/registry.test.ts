import { describe, expect, it } from "vitest";
import {
  ArtifactKindRegistry,
  isKnownArtifactKind,
  validateContentMeta,
} from "../index.js";

describe("ArtifactKindRegistry", () => {
  it("registers all v1 kinds", () => {
    expect(Object.keys(ArtifactKindRegistry).sort()).toEqual([
      "chart",
      "code.file",
      "code.patch",
      "data.table",
      "doc.markdown",
      "doc.office",
      "web.app",
    ]);
  });

  it("isKnownArtifactKind discriminates", () => {
    expect(isKnownArtifactKind("code.file")).toBe(true);
    expect(isKnownArtifactKind("nonsense")).toBe(false);
  });
});

describe("validateContentMeta — code.file", () => {
  it("accepts null meta", () => {
    expect(validateContentMeta("code.file", null)).toEqual({ ok: true });
  });
  it("accepts a clean meta", () => {
    expect(
      validateContentMeta("code.file", { language: "ts", line_count: 42 }),
    ).toEqual({ ok: true });
  });
  it("rejects wrong types", () => {
    const out = validateContentMeta("code.file", { language: 123 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatch(/language/);
  });
});

describe("validateContentMeta — code.patch", () => {
  it("requires target_ref", () => {
    expect(validateContentMeta("code.patch", null).ok).toBe(false);
    expect(validateContentMeta("code.patch", {}).ok).toBe(false);
    expect(validateContentMeta("code.patch", { target_ref: "main" })).toEqual({ ok: true });
  });
});

describe("validateContentMeta — web.app", () => {
  it("requires entry", () => {
    expect(validateContentMeta("web.app", null).ok).toBe(false);
    expect(validateContentMeta("web.app", { entry: "index.html" })).toEqual({ ok: true });
  });
});

describe("validateContentMeta — unknown kind", () => {
  it("rejects with clear message", () => {
    const out = validateContentMeta("nonsense", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatch(/unknown/);
  });
});

describe("validateContentMeta — chart", () => {
  it("rejects unknown format", () => {
    const out = validateContentMeta("chart", { format: "bogus" });
    expect(out.ok).toBe(false);
  });
  it("accepts svg + vega-lite", () => {
    expect(validateContentMeta("chart", { format: "svg" }).ok).toBe(true);
    expect(validateContentMeta("chart", { format: "vega-lite" }).ok).toBe(true);
  });
});
