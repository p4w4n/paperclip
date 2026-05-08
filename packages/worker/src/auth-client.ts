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
