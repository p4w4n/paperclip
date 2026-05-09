import { describe, expect, it, vi } from "vitest";
import { createArtifactsService } from "../service.js";
import { ArtifactsTenantMismatchError } from "../types.js";
import type { StorageProvider } from "../../../storage/types.js";

function fakeProvider(): StorageProvider {
  return {
    id: "local_disk",
    putObject: vi.fn(async () => {}),
    headObject: vi.fn(async () => ({ exists: false })),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeDb({ parentId }: { parentId: string | null }) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => (parentId ? [{ id: parentId }] : [])),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          inserts.push(v);
          return [{ id: "art-new" }];
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updates.push(v);
        }),
      })),
    })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    select: tx.select,
    update: tx.update,
  };
  return { db, inserts, updates };
}

describe("ArtifactsService.declare", () => {
  it("rejects cross-company calls", async () => {
    const { db } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    await expect(
      svc.declare(
        { callerCompanyId: "co-A" },
        {
          scope: { companyId: "co-B" },
          kind: "code.file",
          name: "src/foo.ts",
          contentBytes: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
      ),
    ).rejects.toBeInstanceOf(ArtifactsTenantMismatchError);
  });

  it("rejects unknown kind", async () => {
    const { db } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    await expect(
      svc.declare(
        { callerCompanyId: "co-1" },
        {
          scope: { companyId: "co-1" },
          kind: "nonsense",
          name: "x",
          contentBytes: new TextEncoder().encode("y"),
          contentType: "text/plain",
        },
      ),
    ).rejects.toThrow(/unknown.*kind/);
  });

  it("rejects invalid content_meta for the kind", async () => {
    const { db } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    await expect(
      svc.declare(
        { callerCompanyId: "co-1" },
        {
          scope: { companyId: "co-1" },
          kind: "code.patch", // requires target_ref
          name: "x.patch",
          contentBytes: new TextEncoder().encode("y"),
          contentType: "text/x-diff",
          contentMeta: {}, // missing target_ref
        },
      ),
    ).rejects.toThrow(/target_ref/);
  });

  it("inserts a fresh artifact when no parent exists", async () => {
    const { db, inserts, updates } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    const result = await svc.declare(
      { callerCompanyId: "co-1" },
      {
        scope: { companyId: "co-1", runId: "r-1" },
        kind: "code.file",
        name: "src/foo.ts",
        contentBytes: new TextEncoder().encode("hello"),
        contentType: "text/plain",
      },
    );
    expect(result).toEqual({ id: "art-new", superseded: false, previewQueued: false });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("supersedes the prior version when (issue, name) collides", async () => {
    const { db, inserts, updates } = fakeDb({ parentId: "art-old" });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    const result = await svc.declare(
      { callerCompanyId: "co-1" },
      {
        scope: { companyId: "co-1", issueId: "iss-1" },
        kind: "code.file",
        name: "src/foo.ts",
        contentBytes: new TextEncoder().encode("hello"),
        contentType: "text/plain",
      },
    );
    expect(result.superseded).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].parentId).toBe("art-old");
    expect(updates).toHaveLength(1);
    expect(updates[0].supersededById).toBe("art-new");
  });

  it("rejects empty bodies", async () => {
    const { db } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    await expect(
      svc.declare(
        { callerCompanyId: "co-1" },
        {
          scope: { companyId: "co-1" },
          kind: "code.file",
          name: "x",
          contentBytes: new Uint8Array(0),
          contentType: "text/plain",
        },
      ),
    ).rejects.toThrow(/empty/);
  });

  it("rejects oversized inline bytes", async () => {
    const { db } = fakeDb({ parentId: null });
    const svc = createArtifactsService({ db, storageProvider: fakeProvider() });
    const huge = new Uint8Array(17 * 1024 * 1024);
    await expect(
      svc.declare(
        { callerCompanyId: "co-1" },
        {
          scope: { companyId: "co-1" },
          kind: "code.file",
          name: "huge.ts",
          contentBytes: huge,
          contentType: "text/plain",
        },
      ),
    ).rejects.toThrow(/exceeds.*bytes/);
  });
});
