import { describe, expect, it } from "vitest";
import { normalizeAgentMentionToken } from "../services/issues.ts";

describe("normalizeAgentMentionToken", () => {
  it("decodes hex numeric entities such as space (&#x20;)", () => {
    expect(normalizeAgentMentionToken("Baba&#x20;")).toBe("Baba");
  });

  it("decodes decimal numeric entities", () => {
    expect(normalizeAgentMentionToken("Baba&#32;")).toBe("Baba");
  });

  it("decodes common named whitespace entities", () => {
    expect(normalizeAgentMentionToken("Baba&nbsp;")).toBe("Baba");
  });

  /**
   * Greptile (PR review): cover an entity in the *middle* of a token, not only trailing `&#x20;` / `&nbsp;`.
   * Earlier implementation *stripped* `&amp;`, turning `Ba&amp;ba` into `Baba` and breaking names like `M&amp;M`.
   * Current behavior decodes `&amp;` → `&`, so the expected value is `Ba&ba`, not `Baba`.
   */
  it("decodes a named entity mid-token (Ba&amp;ba → Ba&ba, not strip to Baba)", () => {
    expect(normalizeAgentMentionToken("Ba&amp;ba")).toBe("Ba&ba");
  });

  it("decodes &amp; so agent names with ampersands still match", () => {
    expect(normalizeAgentMentionToken("M&amp;M")).toBe("M&M");
  });

  it("decodes additional named entities used in rich text (e.g. &copy;)", () => {
    expect(normalizeAgentMentionToken("Agent&copy;Name")).toBe("Agent©Name");
  });

  it("leaves unknown semicolon-terminated named references unchanged", () => {
    expect(normalizeAgentMentionToken("Baba&notarealentity;")).toBe("Baba&notarealentity;");
  });

  it("returns plain names unchanged", () => {
    expect(normalizeAgentMentionToken("Baba")).toBe("Baba");
  });

  it("trims after decoding entities", () => {
    expect(normalizeAgentMentionToken("Baba&#x20;&#x20;")).toBe("Baba");
  });
});
