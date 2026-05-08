// Handler for the FetchSecrets unary RPC. Spec D2 governs the auth model:
// scope_token alone authenticates this call; scoped_jwt is reserved-but-
// unused in v1. The token is one-time-use, bound to a specific runId, and
// time-boxed to the run's lease window. The handler atomically looks up
// the secrets and invalidates the token in a single deps call so a second
// fetch with the same token fails closed.
//
// Effectful work (token store lookup + agent-permission resolution) lives
// behind SecretsHandlerDeps so the handler is unit-testable without DB.

import { create } from "@bufbuild/protobuf";
import {
  type FetchSecretsRequest,
  type FetchSecretsResponse,
  FetchSecretsResponseSchema,
} from "@paperclipai/worker-rpc";
import type { WorkerAuthStrategy } from "./auth.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

export interface SecretsHandlerDeps {
  // Looks up the secrets bound to the scope_token and atomically
  // invalidates the token. Throws if the token is unknown, expired, or
  // already consumed. Implementation is a Map.delete-then-Map.set in v1
  // (in-memory store); persistent backing is queued for the deployment
  // where a control-plane restart mid-run is realistic enough to plan
  // for.
  lookupAndInvalidate: (scopeToken: string) => Promise<Record<string, string>>;
}

export async function handleFetchSecrets(
  req: FetchSecretsRequest,
  deps: SecretsHandlerDeps,
): Promise<FetchSecretsResponse> {
  // Spec D2: scoped_jwt field is intentionally ignored in v1; scope_token
  // alone authenticates. Reading the field would be a footgun — anyone
  // implementing a server-side check on it would create the
  // false-confidence shape D2 explicitly rejects.
  const secrets = await deps.lookupAndInvalidate(req.scopeToken);
  return create(FetchSecretsResponseSchema, { secrets });
}

// Production-wiring shim that startWorkerGrpcServer plugs in. Kept
// separate from the deps interface so the handler's tests don't need to
// know about WorkerAuthStrategy / WorkerRegistry.
export interface ProdHandlerOpts {
  auth: WorkerAuthStrategy;
  registry: WorkerRegistry;
  scopeTokenStore: { lookupAndInvalidate: (token: string) => Promise<Record<string, string>> };
}

export function buildProdSecretsHandler(opts: ProdHandlerOpts): (req: FetchSecretsRequest) => Promise<FetchSecretsResponse> {
  return (req) => handleFetchSecrets(req, { lookupAndInvalidate: opts.scopeTokenStore.lookupAndInvalidate });
}
