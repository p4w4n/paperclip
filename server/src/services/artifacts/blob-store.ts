// Content-addressed blob storage helper for artifacts.
//
// Bypasses StorageService.putFile (which generates random UUID-keyed
// paths) so identical artifact content shares one storage object.
// Layout:
//   <companyId>/artifacts/blobs/<sha[0:2]>/<sha>
//
// Dedup: headObject first; if it exists, skip the put. Returns
// alreadyExisted=true so callers can suppress upload-traffic
// metrics for repeats.
//
// Pure-ish (does I/O against the provider). Tests stub the
// provider with a vi.fn() pair.

import { createHash } from "node:crypto";
import type { StorageProvider } from "../../storage/types.js";
import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";

export interface HashAndStoreInput {
  companyId: string;
  bytes: Uint8Array;
  contentType: string;
  provider: StorageProvider;
}

export interface HashAndStoreResult {
  blobSha256: string;
  blobBytes: number;
  blobStorageProvider: StorageProviderId;
  blobStorageKey: string;
  alreadyExisted: boolean;
}

export function buildBlobKey(companyId: string, sha256: string): string {
  // Mirror the existing storage layout's company-prefix shape.
  const prefix = sha256.slice(0, 2);
  return `${companyId}/artifacts/blobs/${prefix}/${sha256}`;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashAndStore(
  input: HashAndStoreInput,
): Promise<HashAndStoreResult> {
  const blobBytes = input.bytes.byteLength;
  if (blobBytes === 0) {
    throw new Error("artifact body is empty");
  }
  const blobSha256 = hashBytes(input.bytes);
  const blobStorageKey = buildBlobKey(input.companyId, blobSha256);

  // Dedup probe — head before put.
  const head = await input.provider.headObject({ objectKey: blobStorageKey });
  if (head.exists) {
    return {
      blobSha256,
      blobBytes,
      blobStorageProvider: input.provider.id,
      blobStorageKey,
      alreadyExisted: true,
    };
  }

  const buffer = Buffer.from(input.bytes);
  await input.provider.putObject({
    objectKey: blobStorageKey,
    body: buffer,
    contentType: input.contentType,
    contentLength: buffer.byteLength,
  });

  return {
    blobSha256,
    blobBytes,
    blobStorageProvider: input.provider.id,
    blobStorageKey,
    alreadyExisted: false,
  };
}
