// Plan 5 worker-side: resolve which session source to use. Inline
// bytes (Plan 1 default) for small sessions; signed URL for large
// ones (over the server's redirect threshold). URI wins when both
// are populated — the server only sets URI when it has already
// uploaded, so inline bytes in that case are stale.
//
// Pure function over the two fields + an injectable fetch. Tests
// pass a vi.fn(); production passes globalThis.fetch.

export interface ResolveSessionRestoreInput {
  sessionRestore: Uint8Array;
  sessionRestoreUri: string;
  fetch: (url: string) => Promise<Uint8Array>;
}

export async function resolveSessionRestore(input: ResolveSessionRestoreInput): Promise<Uint8Array> {
  if (input.sessionRestoreUri) {
    return input.fetch(input.sessionRestoreUri);
  }
  return input.sessionRestore;
}

// Production fetch — wraps globalThis.fetch with the same semantics
// the helper expects. Surfaces non-2xx as throws so callers see them
// as RunFailed candidates rather than silent empty sessions.
export async function defaultSessionFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`session fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
