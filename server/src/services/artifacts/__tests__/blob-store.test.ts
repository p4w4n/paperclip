import { describe, expect, it, vi } from "vitest";
import { buildBlobKey, hashAndStore, hashBytes } from "../blob-store.js";
import type { StorageProvider } from "../../../storage/types.js";

function fakeProvider(opts: { exists: boolean }): StorageProvider {
  return {
    id: "local_disk",
    putObject: vi.fn(async () => {}),
    headObject: vi.fn(async () => ({ exists: opts.exists })),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const someBytes = new TextEncoder().encode("hello world");

describe("hashBytes", () => {
  it("produces a stable sha256 hex digest", () => {
    expect(hashBytes(someBytes)).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("buildBlobKey", () => {
  it("uses 2-char prefix shard under companies/<id>/artifacts/blobs/", () => {
    const sha = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    expect(buildBlobKey("co-1", sha)).toBe(
      `co-1/artifacts/blobs/b9/${sha}`,
    );
  });
});

describe("hashAndStore", () => {
  it("uploads when the key doesn't already exist", async () => {
    const provider = fakeProvider({ exists: false });
    const result = await hashAndStore({
      companyId: "co-1",
      bytes: someBytes,
      contentType: "text/plain",
      provider,
    });
    expect(result.alreadyExisted).toBe(false);
    expect(result.blobBytes).toBe(11);
    expect(provider.putObject).toHaveBeenCalledTimes(1);
  });

  it("dedupes when the key exists", async () => {
    const provider = fakeProvider({ exists: true });
    const result = await hashAndStore({
      companyId: "co-1",
      bytes: someBytes,
      contentType: "text/plain",
      provider,
    });
    expect(result.alreadyExisted).toBe(true);
    expect(provider.putObject).not.toHaveBeenCalled();
  });

  it("rejects empty bodies", async () => {
    const provider = fakeProvider({ exists: false });
    await expect(
      hashAndStore({
        companyId: "co-1",
        bytes: new Uint8Array(0),
        contentType: "text/plain",
        provider,
      }),
    ).rejects.toThrow(/empty/);
  });
});
