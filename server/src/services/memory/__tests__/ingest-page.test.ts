import { describe, expect, it, vi } from "vitest";
import {
  buildClusterUserPrompt,
  ingestPageTick,
  parseClusterResponse,
} from "../ingest-page.js";
import type { WikiBackend } from "../types.js";

describe("buildClusterUserPrompt", () => {
  it("emits ids + kinds + content", () => {
    const out = buildClusterUserPrompt([
      { id: "f-1", content: "uses pnpm", kind: "semantic" },
      { id: "f-2", content: "always tests first", kind: "procedural" },
    ]);
    expect(out).toContain("(f-1) [semantic] uses pnpm");
    expect(out).toContain("(f-2) [procedural] always tests first");
  });
});

describe("parseClusterResponse", () => {
  it("returns [] for empty input", () => {
    expect(parseClusterResponse("")).toEqual([]);
  });

  it("returns [] when JSON is malformed", () => {
    expect(parseClusterResponse("{not json}")).toEqual([]);
  });

  it("parses a clean response", () => {
    const out = parseClusterResponse(
      JSON.stringify({
        pages: [
          {
            slug: "deploy",
            title: "Deploy",
            sourceFactIds: ["f-1", "f-2"],
            content: "## Steps\n[[rollback]]",
            links: ["rollback"],
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("deploy");
    expect(out[0].links).toEqual(["rollback"]);
  });

  it("filters malformed page entries", () => {
    const out = parseClusterResponse(
      JSON.stringify({
        pages: [
          { slug: "ok", title: "Ok", sourceFactIds: ["f-1"], content: "x" },
          { slug: 123 }, // wrong type
          { foo: "bar" },
        ],
      }),
    );
    expect(out).toHaveLength(1);
  });
});

describe("ingestPageTick", () => {
  function fakeWiki(): WikiBackend {
    return {
      upsertPage: vi.fn(async () => ({ id: "page-x", superseded: false })),
      recallPages: vi.fn(),
      lintPage: vi.fn(),
      listLinkedPages: vi.fn(),
      forget: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function makeDb(facts: Array<Record<string, unknown>>) {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => facts),
          })),
        })),
      })),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { select } as any;
  }

  it("does nothing when facts < minClusterSize", async () => {
    const db = makeDb([{ id: "f-1", companyId: "co-1", agentId: null, userId: null, content: "x", kind: "semantic" }]);
    const llm = { generate: vi.fn() };
    const wiki = fakeWiki();
    const out = await ingestPageTick({ db, llm, wiki });
    expect(out.pagesWritten).toBe(0);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("groups by company+agent and upserts pages with filtered source ids", async () => {
    const db = makeDb([
      { id: "f-1", companyId: "co-1", agentId: "ag-1", userId: null, content: "a", kind: "semantic" },
      { id: "f-2", companyId: "co-1", agentId: "ag-1", userId: null, content: "b", kind: "semantic" },
      { id: "f-3", companyId: "co-2", agentId: null, userId: null, content: "c", kind: "procedural" },
    ]);
    const llm = {
      generate: vi.fn(async () =>
        JSON.stringify({
          pages: [
            {
              slug: "p1",
              title: "P1",
              // Mix real + hallucinated id; the hallucinated one
              // ("f-99") must be filtered out.
              sourceFactIds: ["f-1", "f-2", "f-99"],
              content: "page 1",
              links: [],
            },
          ],
        }),
      ),
    };
    const wiki = fakeWiki();
    const out = await ingestPageTick({ db, llm, wiki });
    // co-2 group only has 1 fact -> skipped (below minClusterSize)
    // co-1 group has 2 facts -> 1 LLM call, 1 page
    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(out.pagesWritten).toBe(1);
    const callArg = (wiki.upsertPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.sourceEntryIds).toEqual(["f-1", "f-2"]);
    expect(callArg.scope).toEqual({ companyId: "co-1", agentId: "ag-1" });
  });

  it("counts an error and continues when an upsert fails", async () => {
    const db = makeDb([
      { id: "f-1", companyId: "co-1", agentId: null, userId: null, content: "a", kind: "semantic" },
      { id: "f-2", companyId: "co-1", agentId: null, userId: null, content: "b", kind: "semantic" },
    ]);
    const llm = {
      generate: vi.fn(async () =>
        JSON.stringify({
          pages: [
            { slug: "x", title: "X", sourceFactIds: ["f-1", "f-2"], content: "x", links: [] },
          ],
        }),
      ),
    };
    const wiki = fakeWiki();
    (wiki.upsertPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const out = await ingestPageTick({ db, llm, wiki });
    expect(out.errors).toBe(1);
    expect(out.pagesWritten).toBe(0);
  });
});
