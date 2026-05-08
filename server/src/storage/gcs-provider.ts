// Plan 5: GCS storage provider. Mirrors the s3-provider shape so the
// existing storage call sites work unchanged across providers — flip
// PAPERCLIP_STORAGE_PROVIDER=gcs and a bucket name and you're done.
//
// `GcsBucketLike` is a minimal interface over the methods we actually
// use on @google-cloud/storage's Bucket: `file(key)` returning an
// object with save/download/delete/getMetadata/createReadStream. Tests
// inject a fake; production lazy-imports the real Storage client and
// passes its bucket() through.

import { Readable } from "node:stream";
import type {
  StorageProvider,
  GetObjectResult,
  HeadObjectResult,
  PutObjectInput,
  GetObjectInput,
} from "./types.js";
import { notFound } from "../errors.js";

export interface GcsFileLike {
  save(data: Buffer, opts: { contentType?: string }): Promise<unknown>;
  download(): Promise<[Buffer]>;
  delete(): Promise<unknown>;
  getMetadata(): Promise<[{ contentType?: string; size?: number | string; etag?: string; updated?: string }]>;
  createReadStream(): Readable;
}

export interface GcsBucketLike {
  file(key: string): GcsFileLike;
}

export interface GcsProviderConfig {
  bucket: GcsBucketLike;
  prefix?: string;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number | string } | null;
  if (!e) return false;
  // GCS errors carry numeric `code` for HTTP status; some wrappers
  // surface it as a string.
  return e.code === 404 || e.code === "404";
}

export function createGcsStorageProvider(config: GcsProviderConfig): StorageProvider {
  const prefix = normalizePrefix(config.prefix);
  const bucket = config.bucket;

  return {
    id: "gcs",

    async putObject(input: PutObjectInput) {
      const key = buildKey(prefix, input.objectKey);
      await bucket.file(key).save(input.body, { contentType: input.contentType });
    },

    async getObject(input: GetObjectInput): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      const file = bucket.file(key);
      let metadata: { contentType?: string; size?: number | string; etag?: string; updated?: string };
      try {
        [metadata] = await file.getMetadata();
      } catch (err) {
        if (isNotFound(err)) throw notFound(`Object ${input.objectKey} not found`);
        throw err;
      }
      const contentLength =
        typeof metadata.size === "string" ? Number(metadata.size) : metadata.size;
      return {
        stream: file.createReadStream(),
        contentType: metadata.contentType,
        contentLength: typeof contentLength === "number" && Number.isFinite(contentLength) ? contentLength : undefined,
        etag: metadata.etag,
        lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
      };
    },

    async headObject(input: GetObjectInput): Promise<HeadObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const [metadata] = await bucket.file(key).getMetadata();
        const contentLength =
          typeof metadata.size === "string" ? Number(metadata.size) : metadata.size;
        return {
          exists: true,
          contentType: metadata.contentType,
          contentLength: typeof contentLength === "number" && Number.isFinite(contentLength) ? contentLength : undefined,
          etag: metadata.etag,
          lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
        };
      } catch (err) {
        if (isNotFound(err)) return { exists: false };
        throw err;
      }
    },

    async deleteObject(input: GetObjectInput) {
      const key = buildKey(prefix, input.objectKey);
      try {
        await bucket.file(key).delete();
      } catch (err) {
        // Idempotent: deleting a missing object is success.
        if (!isNotFound(err)) throw err;
      }
    },
  };
}
