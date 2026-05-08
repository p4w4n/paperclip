// Stub for the FetchSecrets unary RPC. Returns an empty bundle in v1; the
// real implementation lands in Task 11, where the worker exchanges its
// scope_token for the per-run secret material gated by agent-permissions
// (spec D2).

import { create } from "@bufbuild/protobuf";
import {
  type FetchSecretsRequest,
  type FetchSecretsResponse,
  FetchSecretsResponseSchema,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

export async function handleFetchSecrets(
  _req: FetchSecretsRequest,
  _opts: { auth: WorkerAuthStrategy; registry: WorkerRegistry },
): Promise<FetchSecretsResponse> {
  return create(FetchSecretsResponseSchema, { secrets: {} });
}
