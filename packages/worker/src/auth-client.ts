import * as grpc from "@grpc/grpc-js";

// Worker-side counterpart to server/src/worker-rpc/auth.ts. Returns a
// gRPC Metadata object with the right authorization header for the
// configured auth strategy. Two strategies planned:
//
//   - staticBearerAuth(token) — pairs with the server's
//     sharedSecretAuthStrategy. Works without GCP; default for
//     local-trusted dev.
//
//   - gcpIdTokenAuth() — Task 15. Reads a fresh GCE id-token from the
//     metadata server with audience pointing at the control plane, returns
//     it as a Bearer header. Refreshed before expiry.
//
// Both implement WorkerAuthClient.getMetadata() so the connect loop can
// stay strategy-agnostic.

export interface WorkerAuthClient {
  getMetadata(): Promise<grpc.Metadata>;
}

export function staticBearerAuth(token: string): WorkerAuthClient {
  return {
    async getMetadata() {
      const md = new grpc.Metadata();
      md.set("authorization", `Bearer ${token}`);
      return md;
    },
  };
}

export interface GcpIdTokenAuthOpts {
  // The audience claim to bake into the requested id-token. Must match
  // the server's WORKER_GCP_AUDIENCE exactly — Google's verifier
  // rejects a mismatched `aud`.
  audience: string;
  // Test-injectable token fetcher. Production defaults to
  // defaultFetchTokenFromMetadata which hits the GCE instance metadata
  // server; tests stub it with vi.fn().
  fetchToken?: (audience: string) => Promise<string>;
}

// GCE instance metadata server returns a fresh id-token on every request,
// stamped with the requested audience. The `Metadata-Flavor: Google`
// header is required — Google rejects requests without it as a defense
// against SSRF tricking the metadata service into responding via a
// browser. The endpoint is link-local (169.254.169.254) so this only
// works on a GCE VM (or a workload-identity-enabled GKE pod, which
// proxies the same shape).
async function defaultFetchTokenFromMetadata(audience: string): Promise<string> {
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata id-token fetch failed: ${res.status}`);
  return res.text();
}

export function gcpIdTokenAuth(opts: GcpIdTokenAuthOpts): WorkerAuthClient {
  const fetchToken = opts.fetchToken ?? defaultFetchTokenFromMetadata;
  return {
    // No client-side caching: the metadata server caches per-VM and
    // returns a fresh token within seconds of expiry, so a per-getMetadata
    // fetch is cheap and avoids us getting wedged on a stale token if
    // the worker reconnects after a long idle. If profiling later shows
    // the metadata roundtrip is hot, add a token-with-expiry cache here.
    async getMetadata() {
      const md = new grpc.Metadata();
      const tok = await fetchToken(opts.audience);
      md.set("authorization", `Bearer ${tok}`);
      return md;
    },
  };
}
