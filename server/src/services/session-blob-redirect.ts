// Plan 5: pre-dispatch redirect for large adapter session blobs.
// The gRPC server's default max message size is 4MB; large session
// restores would either fail outright or pin the bidi stream's
// frame size. resolveSessionBlob picks: under threshold → inline
// bytes on RunDispatch.session_restore; over threshold → upload to
// storage and ship a signed URL via RunDispatch.session_restore_uri.
//
// Pure decision over (sessionRestore, threshold, putToStorage).
// Tests don't need real storage; production wires putToStorage to
// storage.putObject + signed-URL helper.

export interface ResolveSessionBlobInput {
  sessionRestore: Buffer | Uint8Array | undefined;
  // Inline cutoff. Default in production is 1MB; configurable per
  // deployment. Tests pass small values.
  thresholdBytes: number;
  // Uploads `bytes` to a run-scoped path and returns a short-lived
  // signed URL the worker can GET. Caller (server-side wiring)
  // chooses the path key + signing TTL.
  putToStorage: (bytes: Buffer, runId: string) => Promise<string>;
  runId: string;
}

export type ResolvedSessionBlob =
  | { mode: "inline"; bytes: Buffer }
  | { mode: "uri"; uri: string };

export async function resolveSessionBlob(input: ResolveSessionBlobInput): Promise<ResolvedSessionBlob> {
  const raw = input.sessionRestore;
  if (!raw || raw.length === 0) {
    return { mode: "inline", bytes: Buffer.alloc(0) };
  }
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length <= input.thresholdBytes) {
    return { mode: "inline", bytes: buf };
  }
  const uri = await input.putToStorage(buf, input.runId);
  return { mode: "uri", uri };
}
