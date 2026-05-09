import { describe, expect, it, vi } from "vitest";
import {
  embedPendingFacts,
  embedPendingPages,
  reflectionTick,
} from "../reflection-worker.js";
import type { EmbeddingProvider } from "../embedding.js";

function fakeEmbedder(over: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "voyage-3-large",
    dimension: 4,
    embed: vi.fn(async (texts: string[]) =>
      texts.map((_, i) => Float32Array.from([i, i, i, i])),
    ),
    ...over,
  };
}

function makeDb(rows: Array<{ id: string; content?: string; title?: string; contentMarkdown?: string }>) {
  const updates: Array<{ id: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const select = vi.fn((..._: any[]) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => {
        updates.push({ id: "tracked" });
      }),
    })),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { select, update } as any, updates };
}

describe("embedPendingFacts", () => {
  it("returns 0 when nothing is pending", async () => {
    const { db } = makeDb([]);
    const out = await embedPendingFacts(db, fakeEmbedder(), 32);
    expect(out).toEqual({ embedded: 0, errors: 0 });
  });

  it("embeds + updates each row", async () => {
    const { db, updates } = makeDb([
      { id: "f-1", content: "fact a" },
      { id: "f-2", content: "fact b" },
    ]);
    const embedder = fakeEmbedder();
    const out = await embedPendingFacts(db, embedder, 32);
    expect(out.embedded).toBe(2);
    expect(embedder.embed).toHaveBeenCalledWith(["fact a", "fact b"]);
    expect(updates).toHaveLength(2);
  });

  it("counts an error when the embedder throws", async () => {
    const { db } = makeDb([{ id: "f-1", content: "x" }]);
    const embedder = fakeEmbedder({
      embed: vi.fn(async () => {
        throw new Error("voyage 503");
      }),
    });
    const out = await embedPendingFacts(db, embedder, 32);
    expect(out.embedded).toBe(0);
    expect(out.errors).toBe(1);
  });
});

describe("embedPendingPages", () => {
  it("concatenates title + content for the embedding input", async () => {
    const { db } = makeDb([
      { id: "p-1", title: "Deploy", contentMarkdown: "Steps." },
    ]);
    const embedder = fakeEmbedder();
    await embedPendingPages(db, embedder, 32);
    expect(embedder.embed).toHaveBeenCalledWith(["Deploy\n\nSteps."]);
  });
});

describe("reflectionTick", () => {
  it("aggregates facts + pages results", async () => {
    const { db } = makeDb([{ id: "x" }]);
    const out = await reflectionTick({ db, embedder: fakeEmbedder(), batchSize: 32 });
    expect(out.errors).toBe(0);
    // Both stages called against the same fake "rows" — the same
    // embedder runs twice. We mostly want to confirm the shape.
    expect(out).toHaveProperty("factsEmbedded");
    expect(out).toHaveProperty("pagesEmbedded");
  });
});
