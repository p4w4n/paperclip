// Tests the run-event helpers. Verifies (a) the right scope is
// derived, (b) episodic content is shaped correctly, (c) write
// failures are absorbed (fire-and-forget), (d) the comment excerpt
// is trimmed.

import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../service.js";
import type { MemoryBackend, WikiBackend } from "../types.js";
import {
  recordRunComment,
  recordRunFinish,
  recordRunStart,
} from "../run-events.js";

function makeSvc() {
  const writes: Array<unknown> = [];
  const memoryBackend: MemoryBackend = {
    write: vi.fn(async (input) => {
      writes.push(input);
      return { id: "fake" };
    }),
    recall: vi.fn(async () => []),
    forget: vi.fn(async () => {}),
  };
  const wikiBackend: WikiBackend = {
    upsertPage: vi.fn(),
    recallPages: vi.fn(),
    lintPage: vi.fn(),
    listLinkedPages: vi.fn(),
    forget: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { svc: new MemoryService(memoryBackend, wikiBackend), writes, memoryBackend };
}

describe("recordRunStart", () => {
  it("writes an episodic entry with issue scope when issueId is present", async () => {
    const { svc, writes } = makeSvc();
    recordRunStart(svc, {
      runId: "r-1",
      companyId: "co-1",
      agentId: "ag-1",
      issueId: "iss-1",
      issueTitle: "fix flaky test",
    });
    await new Promise((r) => setImmediate(r));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      scope: {
        companyId: "co-1",
        agentId: "ag-1",
        sessionId: "iss-1",
        sessionKind: "issue",
      },
      kind: "episodic",
      content: "Run started for issue 'fix flaky test'",
      sourceRunId: "r-1",
    });
  });

  it("falls back to run scope when no issueId", async () => {
    const { svc, writes } = makeSvc();
    recordRunStart(svc, {
      runId: "r-2",
      companyId: "co-1",
    });
    await new Promise((r) => setImmediate(r));
    expect(writes[0]).toMatchObject({
      scope: { sessionId: "r-2", sessionKind: "run" },
      content: "Run r-2 started",
    });
  });
});

describe("recordRunFinish", () => {
  it("includes summary when present", async () => {
    const { svc, writes } = makeSvc();
    recordRunFinish(svc, {
      runId: "r-1",
      companyId: "co-1",
      issueId: "iss-1",
      exitCode: 0,
      summary: "passed all checks",
    });
    await new Promise((r) => setImmediate(r));
    expect((writes[0] as { content: string }).content).toBe(
      "Run finished (exit 0): passed all checks",
    );
  });
});

describe("recordRunComment", () => {
  it("trims long excerpts to 500 chars + ellipsis", async () => {
    const { svc, writes } = makeSvc();
    const longComment = "x".repeat(1000);
    recordRunComment(svc, {
      runId: "r-1",
      companyId: "co-1",
      issueId: "iss-1",
      commentBy: "user-1",
      commentExcerpt: longComment,
    });
    await new Promise((r) => setImmediate(r));
    const content = (writes[0] as { content: string }).content;
    expect(content).toMatch(/Comment from user-1:/);
    // 500 chars + ellipsis + the prefix
    expect(content.length).toBeLessThan(550);
    expect(content.endsWith("…")).toBe(true);
  });
});

describe("fire-and-forget", () => {
  it("does not throw when the underlying write fails", () => {
    // Build a service whose backend rejects.
    const memoryBackend: MemoryBackend = {
      write: vi.fn(async () => {
        throw new Error("backend down");
      }),
      recall: vi.fn(async () => []),
      forget: vi.fn(async () => {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MemoryService(memoryBackend, {} as any);
    expect(() =>
      recordRunStart(svc, {
        runId: "r-1",
        companyId: "co-1",
      }),
    ).not.toThrow();
  });
});
