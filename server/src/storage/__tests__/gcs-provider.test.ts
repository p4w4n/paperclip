// Plan 5: GCS storage provider. Tests use a fake GCS Bucket so neither
// network nor @google-cloud/storage is required. Production wiring
// lazy-imports the real client at boot.

import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { createGcsStorageProvider, type GcsBucketLike } from "../gcs-provider.js";

function fakeFile() {
  let storedBody: Buffer = Buffer.alloc(0);
  let storedMeta: { contentType?: string; size?: number; etag?: string; updated?: string } = {};
  let exists = false;
  return {
    save: vi.fn(async (data: Buffer, opts: { contentType?: string }) => {
      storedBody = data;
      storedMeta = {
        contentType: opts.contentType,
        size: data.length,
        etag: "fake-etag",
        updated: new Date().toISOString(),
      };
      exists = true;
    }),
    download: vi.fn(async () => [storedBody] as [Buffer]),
    delete: vi.fn(async () => {
      exists = false;
    }),
    getMetadata: vi.fn(async () => {
      if (!exists) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 404;
        throw err;
      }
      return [storedMeta] as [typeof storedMeta];
    }),
    createReadStream: () => Readable.from([storedBody]),
  };
}

function fakeBucket(): GcsBucketLike & { _files: Map<string, ReturnType<typeof fakeFile>> } {
  const files = new Map<string, ReturnType<typeof fakeFile>>();
  return {
    file: (key: string) => {
      let f = files.get(key);
      if (!f) {
        f = fakeFile();
        files.set(key, f);
      }
      return f;
    },
    _files: files,
  };
}

describe("createGcsStorageProvider", () => {
  it("putObject + getObject roundtrips", async () => {
    const bucket = fakeBucket();
    const provider = createGcsStorageProvider({ bucket });
    await provider.putObject({
      objectKey: "k/1",
      body: Buffer.from("hello"),
      contentType: "text/plain",
      contentLength: 5,
    });
    const got = await provider.getObject({ objectKey: "k/1" });
    expect(got.contentType).toBe("text/plain");
    expect(got.contentLength).toBe(5);
    const chunks: Buffer[] = [];
    for await (const chunk of got.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("headObject returns exists=false on 404", async () => {
    const bucket = fakeBucket();
    const provider = createGcsStorageProvider({ bucket });
    const head = await provider.headObject({ objectKey: "missing" });
    expect(head.exists).toBe(false);
  });

  it("headObject returns metadata when present", async () => {
    const bucket = fakeBucket();
    const provider = createGcsStorageProvider({ bucket });
    await provider.putObject({
      objectKey: "present",
      body: Buffer.from("x"),
      contentType: "text/plain",
      contentLength: 1,
    });
    const head = await provider.headObject({ objectKey: "present" });
    expect(head.exists).toBe(true);
    expect(head.contentType).toBe("text/plain");
    expect(head.contentLength).toBe(1);
  });

  it("deleteObject is idempotent (no-op on missing key)", async () => {
    const bucket = fakeBucket();
    const provider = createGcsStorageProvider({ bucket });
    await expect(provider.deleteObject({ objectKey: "never-was" })).resolves.toBeUndefined();
  });

  it("applies prefix to every operation", async () => {
    const bucket = fakeBucket();
    const provider = createGcsStorageProvider({ bucket, prefix: "team-a" });
    await provider.putObject({
      objectKey: "report.txt",
      body: Buffer.from("x"),
      contentType: "text/plain",
      contentLength: 1,
    });
    expect(bucket._files.has("team-a/report.txt")).toBe(true);
    expect(bucket._files.has("report.txt")).toBe(false);
  });
});
