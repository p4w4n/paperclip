// Worker-side caller for the FetchSecrets unary RPC. Spec D2: scope_token
// alone authenticates; scoped_jwt is reserved-but-unused and the v1
// server ignores it. We pass an empty string so the proto field is
// well-formed without claiming auth credibility we don't have.
//
// Opens a fresh gRPC connection per call. The bidi stream from the
// connect loop carries dispatch + completion + lease frames, NOT
// secrets — keeps the secret path on its own short-lived channel,
// shorter blast radius if the stream gets compromised.

import * as grpc from "@grpc/grpc-js";
import { fromBinary, toBinary, create } from "@bufbuild/protobuf";
import {
  FetchSecretsRequestSchema,
  FetchSecretsResponseSchema,
  type FetchSecretsRequest,
  type FetchSecretsResponse,
} from "@paperclipai/worker-rpc";

export async function fetchSecretsFromControlPlane(
  controlPlaneAddress: string,
  scopeToken: string,
): Promise<Record<string, string>> {
  const client = new grpc.Client(
    controlPlaneAddress,
    grpc.credentials.createInsecure(),
  );

  return new Promise<Record<string, string>>((resolve, reject) => {
    client.makeUnaryRequest<FetchSecretsRequest, FetchSecretsResponse>(
      "/paperclip.v1.Worker/FetchSecrets",
      (m) => Buffer.from(toBinary(FetchSecretsRequestSchema, m)),
      (b) => fromBinary(FetchSecretsResponseSchema, b),
      create(FetchSecretsRequestSchema, { scopeToken, scopedJwt: "" }),
      new grpc.Metadata(),
      (err, resp) => {
        client.close();
        if (err) return reject(err);
        if (!resp) return reject(new Error("no response"));
        // The proto map is a plain JS object after deserialization.
        resolve({ ...resp.secrets });
      },
    );
  });
}
