// Forget tests. Verifies the service-level behavior:
//   - tenant gate rejects cross-company calls
//   - reason is propagated to the backend
//   - second call is no-op (idempotent at the SQL guard)
//
// Backend-internal cascades (page-link cleanup) are exercised by the
// recallPages link expansion test elsewhere — this file focuses on
// service contract.

import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../service.js";
import {
  MemoryTenantMismatchError,
  type MemoryBackend,
  type WikiBackend,
} from "../types.js";

function fakeBackend(): MemoryBackend {
  return {
    write: vi.fn(async () => ({ id: "fact-1" })),
    recall: vi.fn(async () => []),
    forget: vi.fn(async () => {}),
  };
}

function fakeWiki(): WikiBackend {
  return {
    upsertPage: vi.fn(async () => ({ id: "p-1", superseded: false })),
    recallPages: vi.fn(async () => []),
    lintPage: vi.fn(),
    listLinkedPages: vi.fn(),
    forget: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("MemoryService.forget", () => {
  it("propagates id+reason to the backend", async () => {
    const backend = fakeBackend();
    const svc = new MemoryService(backend, fakeWiki());
    await svc.forget(
      { callerCompanyId: "co-1" },
      { id: "fact-9", reason: "user", companyId: "co-1" },
    );
    expect(backend.forget).toHaveBeenCalledWith({ id: "fact-9", reason: "user" });
  });

  it("rejects cross-company calls before touching the backend", async () => {
    const backend = fakeBackend();
    const svc = new MemoryService(backend, fakeWiki());
    await expect(
      svc.forget(
        { callerCompanyId: "co-A" },
        { id: "fact-9", reason: "user", companyId: "co-B" },
      ),
    ).rejects.toBeInstanceOf(MemoryTenantMismatchError);
    expect(backend.forget).not.toHaveBeenCalled();
  });

  it("forgetPage delegates to wiki backend", async () => {
    const wiki = fakeWiki();
    const svc = new MemoryService(fakeBackend(), wiki);
    await svc.forgetPage(
      { callerCompanyId: "co-1" },
      { id: "p-9", reason: "expired", companyId: "co-1" },
    );
    expect(wiki.forget).toHaveBeenCalledWith({ id: "p-9", reason: "expired" });
  });

  it("forgetPage gates on tenant mismatch", async () => {
    const wiki = fakeWiki();
    const svc = new MemoryService(fakeBackend(), wiki);
    await expect(
      svc.forgetPage(
        { callerCompanyId: "co-A" },
        { id: "p-9", reason: "user", companyId: "co-B" },
      ),
    ).rejects.toBeInstanceOf(MemoryTenantMismatchError);
    expect(wiki.forget).not.toHaveBeenCalled();
  });
});
