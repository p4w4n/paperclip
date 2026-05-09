// Smoke test for recallPages — verifies the keyword path returns
// the expected RecalledPage shape and that link expansion attaches
// linkedPages. Vector path is exercised via a stubbed embedder.

import { describe, expect, it, vi } from "vitest";
import { createPgvectorWikiBackend } from "../pgvector-wiki-backend.js";

interface RawRow {
  id: string;
  slug: string;
  title: string;
  content_markdown: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  raw_score: number;
}

function makeDb({
  keywordRows,
  vectorRows,
  linkRows = [],
}: {
  keywordRows: RawRow[];
  vectorRows?: RawRow[];
  linkRows?: Array<{
    id: string;
    slug: string;
    title: string;
    contentMarkdown: string;
    companyId: string;
    userId: string | null;
    agentId: string | null;
    sessionId: string | null;
    fromPageId: string;
  }>;
}) {
  let executeCall = 0;
  const execute = vi.fn(async () => {
    executeCall++;
    if (vectorRows && executeCall === 1) {
      // First call is keyword by current ordering.
    }
    // Order produced by recallPages: keyword first, vector second.
    // Differentiate via call-counter.
    return executeCall === 1 ? { rows: keywordRows } : { rows: vectorRows ?? [] };
  });

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(async () => linkRows),
      })),
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { execute, select } as any;
}

describe("recallPages — keyword path", () => {
  it("returns RecalledPage with matchedVia=embedding", async () => {
    const db = makeDb({
      keywordRows: [
        {
          id: "p-1",
          slug: "deploy-checklist",
          title: "Deploy",
          content_markdown: "deploy steps",
          user_id: null,
          agent_id: null,
          session_id: null,
          raw_score: 1,
        },
      ],
    });
    const backend = createPgvectorWikiBackend(db);
    const out = await backend.recallPages({
      scope: { companyId: "co-1" },
      query: "deploy",
      expandLinks: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "p-1",
      slug: "deploy-checklist",
      matchedVia: "embedding",
    });
    expect(out[0].score).toBeGreaterThan(0);
  });

  it("expandLinks attaches linkedPages from memory_page_links", async () => {
    const db = makeDb({
      keywordRows: [
        {
          id: "p-1",
          slug: "alpha",
          title: "Alpha",
          content_markdown: "[[beta]]",
          user_id: null,
          agent_id: null,
          session_id: null,
          raw_score: 1,
        },
      ],
      linkRows: [
        {
          id: "p-2",
          slug: "beta",
          title: "Beta",
          contentMarkdown: "Beta page",
          companyId: "co-1",
          userId: null,
          agentId: null,
          sessionId: null,
          fromPageId: "p-1",
        },
      ],
    });
    const backend = createPgvectorWikiBackend(db);
    const out = await backend.recallPages({
      scope: { companyId: "co-1" },
      query: "alpha",
    });
    const parent = out.find((p) => p.id === "p-1");
    const child = out.find((p) => p.id === "p-2");
    expect(parent?.linkedPages).toEqual([{ id: "p-2", slug: "beta", title: "Beta" }]);
    expect(child?.matchedVia).toBe("link");
    expect(child?.score).toBe(0.5);
  });
});

describe("recallPages — vector path", () => {
  it("invokes the embedder and merges with keyword hits", async () => {
    const db = makeDb({
      keywordRows: [
        {
          id: "p-1",
          slug: "a",
          title: "A",
          content_markdown: "A content",
          user_id: null,
          agent_id: null,
          session_id: null,
          raw_score: 1,
        },
      ],
      vectorRows: [
        {
          id: "p-1",
          slug: "a",
          title: "A",
          content_markdown: "A content",
          user_id: null,
          agent_id: null,
          session_id: null,
          raw_score: 1,
        },
      ],
    });
    const embedder = {
      id: "voyage-3-large" as const,
      dimension: 1024,
      embed: vi.fn(async () => [Float32Array.from(Array(1024).fill(0.1))]),
    };
    const backend = createPgvectorWikiBackend(db, { embedder });
    const out = await backend.recallPages({
      scope: { companyId: "co-1" },
      query: "anything",
      expandLinks: false,
    });
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Vector + keyword for the same id sums scores → ~1.0
    expect(out[0].score).toBeCloseTo(1.0, 3);
  });

  it("falls back to keyword when embedder throws", async () => {
    const db = makeDb({
      keywordRows: [
        {
          id: "p-1",
          slug: "a",
          title: "A",
          content_markdown: "A content",
          user_id: null,
          agent_id: null,
          session_id: null,
          raw_score: 1,
        },
      ],
    });
    const embedder = {
      id: "voyage-3-large" as const,
      dimension: 1024,
      embed: vi.fn(async () => {
        throw new Error("voyage down");
      }),
    };
    const backend = createPgvectorWikiBackend(db, { embedder });
    const out = await backend.recallPages({
      scope: { companyId: "co-1" },
      query: "anything",
      expandLinks: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("p-1");
  });
});
