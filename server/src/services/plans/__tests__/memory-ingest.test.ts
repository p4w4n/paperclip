import { describe, expect, it, vi } from "vitest";
import { ingestCompletedPlan } from "../memory-ingest.js";

function fakeDb({
  planRow,
  revRow,
  decisionRows = [],
}: {
  planRow?: Record<string, unknown> | null;
  revRow?: Record<string, unknown> | null;
  decisionRows?: Array<Record<string, unknown>>;
}) {
  let call = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          call++;
          if (call === 1) return Promise.resolve(planRow ? [planRow] : []);
          if (call === 2) return Promise.resolve(revRow ? [revRow] : []);
          return Promise.resolve(decisionRows);
        }),
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("ingestCompletedPlan", () => {
  it("returns no-op for missing plan", async () => {
    const db = fakeDb({});
    const memory = { upsertPage: vi.fn(), write: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await ingestCompletedPlan(db, memory as any, "p-x");
    expect(out).toEqual({ pageId: null, factsWritten: 0 });
    expect(memory.upsertPage).not.toHaveBeenCalled();
  });

  it("upserts a wiki page + writes one fact per decision", async () => {
    const db = fakeDb({
      planRow: {
        id: "p-1",
        companyId: "co-1",
        title: "Auth refactor",
        currentRevisionId: "r-1",
      },
      revRow: { contentMarkdown: "## Plan body" },
      decisionRows: [
        {
          title: "DB",
          optionsJson: [{ id: "pg", label: "Postgres" }],
          chosenOptionId: "pg",
          rationaleMarkdown: "we use it",
        },
      ],
    });
    const memory = {
      upsertPage: vi.fn(async () => ({ id: "page-1", superseded: false })),
      write: vi.fn(async () => ({ id: "fact-1" })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await ingestCompletedPlan(db, memory as any, "p-1");
    expect(out).toEqual({ pageId: "page-1", factsWritten: 1 });
    expect(memory.upsertPage).toHaveBeenCalledTimes(1);
    expect(memory.write).toHaveBeenCalledTimes(1);
    const upsertCalls = memory.upsertPage.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>;
    const upsertArg = upsertCalls[0][1];
    expect(upsertArg.slug).toBe("plan-p-1-final");
    expect(upsertArg.contentMarkdown).toContain("Completed plan");
    const writeCalls = memory.write.mock.calls as unknown as Array<[unknown, { content: string }]>;
    const writeArg = writeCalls[0][1];
    expect(writeArg.content).toContain("Decision");
    expect(writeArg.content).toContain("Postgres");
  });
});
