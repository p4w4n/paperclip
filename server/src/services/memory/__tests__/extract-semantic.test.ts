import { describe, expect, it, vi } from "vitest";
import {
  buildExtractionUserPrompt,
  extractSemanticTick,
  parseExtractionResponse,
} from "../extract-semantic.js";

describe("buildExtractionUserPrompt", () => {
  it("numbers each episodic on its own line", () => {
    const out = buildExtractionUserPrompt([
      { content: "user prefers 2-space indent" },
      { content: "user uses pnpm" },
    ]);
    expect(out).toContain("1. user prefers 2-space indent");
    expect(out).toContain("2. user uses pnpm");
  });
});

describe("parseExtractionResponse", () => {
  it("returns [] for empty/garbage input", () => {
    expect(parseExtractionResponse("")).toEqual([]);
    expect(parseExtractionResponse("nope")).toEqual([]);
    expect(parseExtractionResponse("[")).toEqual([]);
  });

  it("parses a clean JSON array", () => {
    const out = parseExtractionResponse(
      '[{"content":"prefers pnpm","kind":"semantic"}]',
    );
    expect(out).toEqual([{ content: "prefers pnpm", kind: "semantic" }]);
  });

  it("tolerates prose around the JSON", () => {
    const out = parseExtractionResponse(
      'Here you go:\n[{"content":"x","kind":"procedural"}]\nlet me know if...',
    );
    expect(out).toEqual([{ content: "x", kind: "procedural" }]);
  });

  it("filters out malformed entries", () => {
    const out = parseExtractionResponse(
      '[{"content":"ok","kind":"semantic"},{"content":"bad","kind":"unknown"},{"foo":1}]',
    );
    expect(out).toEqual([{ content: "ok", kind: "semantic" }]);
  });
});

describe("extractSemanticTick", () => {
  function makeDb(episodics: Array<Record<string, unknown>>) {
    const inserts: Array<Record<string, unknown>> = [];
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => episodics),
          })),
        })),
      })),
    }));
    const insert = vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        inserts.push(v);
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { db: { select, insert } as any, inserts };
  }

  it("returns zeros when nothing to consider", async () => {
    const { db } = makeDb([]);
    const llm = { generate: vi.fn() };
    const out = await extractSemanticTick({ db, llm });
    expect(out).toEqual({ episodicsConsidered: 0, factsExtracted: 0, errors: 0 });
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("groups by company and inserts derived semantics", async () => {
    const { db, inserts } = makeDb([
      {
        id: "e-1",
        companyId: "co-A",
        userId: null,
        agentId: "ag-A",
        sessionId: "s-1",
        sessionKind: "issue",
        content: "user said use pnpm",
      },
      {
        id: "e-2",
        companyId: "co-A",
        userId: null,
        agentId: "ag-A",
        sessionId: "s-2",
        sessionKind: "issue",
        content: "user said pnpm again",
      },
      {
        id: "e-3",
        companyId: "co-B",
        userId: null,
        agentId: "ag-B",
        sessionId: "s-3",
        sessionKind: "issue",
        content: "company B prefers vi",
      },
    ]);
    const llm = {
      generate: vi.fn(async () => '[{"content":"prefers X","kind":"semantic"}]'),
    };
    const out = await extractSemanticTick({ db, llm });
    expect(out.episodicsConsidered).toBe(3);
    expect(out.factsExtracted).toBe(2); // one per company
    expect(llm.generate).toHaveBeenCalledTimes(2);
    // Each insert strips session id (broader scope)
    for (const v of inserts) {
      expect(v.sessionId).toBe(null);
      expect(v.kind).toBe("semantic");
      expect(v.salience).toBe(0.6);
    }
  });

  it("counts an error when the LLM throws and continues to the next group", async () => {
    const { db, inserts } = makeDb([
      {
        id: "e-1",
        companyId: "co-A",
        userId: null,
        agentId: null,
        sessionId: null,
        sessionKind: null,
        content: "x",
      },
      {
        id: "e-2",
        companyId: "co-B",
        userId: null,
        agentId: null,
        sessionId: null,
        sessionKind: null,
        content: "y",
      },
    ]);
    let call = 0;
    const llm = {
      generate: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("rate limited");
        return '[{"content":"recovered","kind":"semantic"}]';
      }),
    };
    const out = await extractSemanticTick({ db, llm });
    expect(out.errors).toBe(1);
    expect(out.factsExtracted).toBe(1);
    expect(inserts).toHaveLength(1);
  });
});
