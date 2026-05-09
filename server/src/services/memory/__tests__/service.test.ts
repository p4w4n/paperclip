// Memory service tests. Covers the tenant-isolation gate (every
// public method must reject cross-company input) and the plugin
// backend swap.

import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../service.js";
import {
  MemoryTenantMismatchError,
  type MemoryBackend,
  type WikiBackend,
} from "../types.js";

function fakeMemoryBackend(): MemoryBackend {
  return {
    write: vi.fn(async () => ({ id: "fact-1" })),
    recall: vi.fn(async () => []),
    forget: vi.fn(async () => {}),
  };
}

function fakeWikiBackend(): WikiBackend {
  return {
    upsertPage: vi.fn(async () => ({ id: "page-1", superseded: false })),
    recallPages: vi.fn(async () => []),
    lintPage: vi.fn(async () => ({ newRevisionId: null, status: "clean" as const, notes: "" })),
    listLinkedPages: vi.fn(async () => []),
    forget: vi.fn(async () => {}),
  };
}

describe("MemoryService — tenant isolation", () => {
  const matrix = [
    {
      name: "write",
      call: (svc: MemoryService) =>
        svc.write(
          { callerCompanyId: "co-A" },
          {
            scope: { companyId: "co-B" },
            kind: "episodic",
            content: "x",
          },
        ),
    },
    {
      name: "recall",
      call: (svc: MemoryService) =>
        svc.recall(
          { callerCompanyId: "co-A" },
          { scope: { companyId: "co-B" }, query: "x" },
        ),
    },
    {
      name: "forget",
      call: (svc: MemoryService) =>
        svc.forget(
          { callerCompanyId: "co-A" },
          { id: "fact-1", reason: "user", companyId: "co-B" },
        ),
    },
    {
      name: "upsertPage",
      call: (svc: MemoryService) =>
        svc.upsertPage(
          { callerCompanyId: "co-A" },
          {
            scope: { companyId: "co-B" },
            slug: "x",
            title: "X",
            contentMarkdown: "x",
          },
        ),
    },
    {
      name: "recallPages",
      call: (svc: MemoryService) =>
        svc.recallPages(
          { callerCompanyId: "co-A" },
          { scope: { companyId: "co-B" }, query: "x" },
        ),
    },
    {
      name: "lintPage",
      call: (svc: MemoryService) =>
        svc.lintPage(
          { callerCompanyId: "co-A" },
          {
            pageId: "p-1",
            companyId: "co-B",
            llm: { generate: async () => "" },
          },
        ),
    },
  ] as const;

  for (const { name, call } of matrix) {
    it(`${name} rejects cross-company input`, async () => {
      const svc = new MemoryService(fakeMemoryBackend(), fakeWikiBackend());
      await expect(call(svc)).rejects.toBeInstanceOf(MemoryTenantMismatchError);
    });
  }
});

describe("MemoryService — backend swap", () => {
  it("setMemoryBackend swaps the implementation", async () => {
    const a = fakeMemoryBackend();
    const b = fakeMemoryBackend();
    const svc = new MemoryService(a, fakeWikiBackend());
    await svc.write(
      { callerCompanyId: "co-1" },
      { scope: { companyId: "co-1" }, kind: "episodic", content: "x" },
    );
    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).not.toHaveBeenCalled();

    svc.setMemoryBackend(b);
    await svc.write(
      { callerCompanyId: "co-1" },
      { scope: { companyId: "co-1" }, kind: "episodic", content: "y" },
    );
    expect(a.write).toHaveBeenCalledTimes(1); // unchanged after swap
    expect(b.write).toHaveBeenCalledTimes(1);
  });

  it("setWikiBackend swaps the implementation", async () => {
    const a = fakeWikiBackend();
    const b = fakeWikiBackend();
    const svc = new MemoryService(fakeMemoryBackend(), a);
    await svc.upsertPage(
      { callerCompanyId: "co-1" },
      { scope: { companyId: "co-1" }, slug: "x", title: "X", contentMarkdown: "x" },
    );
    expect(a.upsertPage).toHaveBeenCalledTimes(1);

    svc.setWikiBackend(b);
    await svc.upsertPage(
      { callerCompanyId: "co-1" },
      { scope: { companyId: "co-1" }, slug: "y", title: "Y", contentMarkdown: "y" },
    );
    expect(a.upsertPage).toHaveBeenCalledTimes(1); // unchanged
    expect(b.upsertPage).toHaveBeenCalledTimes(1);
  });
});
