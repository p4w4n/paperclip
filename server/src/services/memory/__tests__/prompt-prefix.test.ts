import { describe, expect, it } from "vitest";
import { buildMemoryPromptPrefix } from "../prompt-prefix.js";
import type { RecalledEntry, RecalledPage } from "../types.js";

function page(over: Partial<RecalledPage> = {}): RecalledPage {
  return {
    id: "p-1",
    slug: "deploy",
    title: "Deploy",
    contentMarkdown: "Steps to deploy.",
    scope: { kind: "company" },
    score: 0.5,
    matchedVia: "embedding",
    ...over,
  };
}

function fact(over: Partial<RecalledEntry> = {}): RecalledEntry {
  return {
    id: "f-1",
    kind: "semantic",
    content: "Use --force-with-lease, never --force.",
    scope: { kind: "company" },
    score: 0.5,
    ...over,
  };
}

describe("buildMemoryPromptPrefix", () => {
  it("returns empty when both inputs are empty", () => {
    const out = buildMemoryPromptPrefix({ pages: [], facts: [] });
    expect(out.text).toBe("");
    expect(out.truncated).toBe(false);
  });

  it("renders pages then facts inside <memory> tags", () => {
    const out = buildMemoryPromptPrefix({
      pages: [page({ title: "Deploy", contentMarkdown: "Use blue/green." })],
      facts: [fact({ content: "Tests run on CI." })],
    });
    expect(out.text.startsWith("<memory>")).toBe(true);
    expect(out.text.endsWith("</memory>")).toBe(true);
    expect(out.text.indexOf("Deploy")).toBeLessThan(out.text.indexOf("Tests run on CI."));
    expect(out.pagesIncluded).toBe(1);
    expect(out.factsIncluded).toBe(1);
  });

  it("orders by score descending across each section", () => {
    const out = buildMemoryPromptPrefix({
      pages: [
        page({ slug: "low", title: "Low", contentMarkdown: "low", score: 0.1 }),
        page({ slug: "hi", title: "Hi", contentMarkdown: "hi", score: 0.9 }),
      ],
      facts: [
        fact({ content: "low fact", score: 0.1 }),
        fact({ content: "high fact", score: 0.9 }),
      ],
    });
    expect(out.text.indexOf("Hi")).toBeLessThan(out.text.indexOf("Low"));
    expect(out.text.indexOf("high fact")).toBeLessThan(out.text.indexOf("low fact"));
  });

  it("includes link annotations on pages with linkedPages", () => {
    const out = buildMemoryPromptPrefix({
      pages: [
        page({
          linkedPages: [{ id: "p-2", slug: "rollback", title: "Rollback" }],
        }),
      ],
      facts: [],
    });
    expect(out.text).toContain("[[rollback]]");
  });

  it("trims to budget and reports truncated", () => {
    const longContent = "x".repeat(2000);
    const out = buildMemoryPromptPrefix({
      pages: [
        page({ slug: "a", title: "A", contentMarkdown: longContent, score: 0.9 }),
        page({ slug: "b", title: "B", contentMarkdown: longContent, score: 0.8 }),
      ],
      facts: [],
      maxBudgetChars: 2500,
    });
    expect(out.truncated).toBe(true);
    expect(out.pagesIncluded).toBe(1);
  });

  it("renders playbooks above pages + facts when present", () => {
    const out = buildMemoryPromptPrefix({
      playbooks: [
        { title: "Deploy recovery", body: "1. Roll back\n2. Notify ops", score: 0.8 },
      ],
      pages: [page({ slug: "deploy", title: "Deploy", contentMarkdown: "Use blue/green." })],
      facts: [fact({ content: "Tests run on CI." })],
    });
    expect(out.playbooksIncluded).toBe(1);
    expect(out.text.indexOf("Deploy recovery")).toBeLessThan(out.text.indexOf("Deploy"));
    expect(out.text.indexOf("Suggested playbooks")).toBeGreaterThan(-1);
  });

  it("trims fact content over 280 chars", () => {
    const huge = "a".repeat(500);
    const out = buildMemoryPromptPrefix({
      pages: [],
      facts: [fact({ content: huge })],
    });
    expect(out.text).toMatch(/a{280}…/);
  });
});
