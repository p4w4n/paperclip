import { describe, expect, it, vi } from "vitest";
import { declareArtifactInProcess } from "../in-process.js";
import { initializeArtifactsService } from "../service.js";
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

function fakeDb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "art-x" }],
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { transaction: async (fn: any) => fn(tx), select: tx.select } as any;
}

describe("declareArtifactInProcess", () => {
  it("delegates to the singleton service with the caller's company", async () => {
    initializeArtifactsService({ db: fakeDb(), storageProvider: fakeProvider() });
    const result = await declareArtifactInProcess({
      callerCompanyId: "co-1",
      scope: { companyId: "co-1" },
      kind: "code.file",
      name: "src/foo.ts",
      contentBytes: new TextEncoder().encode("hello"),
      contentType: "text/plain",
    });
    expect(result.id).toBe("art-x");
  });
});
