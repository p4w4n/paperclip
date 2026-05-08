import { timingSafeEqual } from "node:crypto";

// Worker authentication strategies for the Worker.Connect handshake.
//
// Two strategies are planned:
//
//   - `sharedSecretAuthStrategy` (this file) — single static bearer token,
//     verified with a constant-time compare. Works without GCP and is the
//     default for local-trusted dev. Set `WORKER_AUTH_MODE=shared_secret`
//     and `WORKER_SHARED_SECRET=<...>` in env.
//
//   - `gcpIdTokenAuthStrategy` (Task 14) — GCP service-account identity
//     token verified via google-auth-library. SA email must be in a
//     configurable allowlist. Provides attested instance identity
//     (instance_id, zone) per spec D2.
//
// Strategies expose a uniform `verify(authorizationHeader): Promise<AuthResult>`
// so the gRPC handler can stay strategy-agnostic. The result carries a
// `WorkerPrincipal` describing what we proved about the caller — useful
// downstream when the audit log needs to record "auth via shared secret"
// vs "auth via attested GCE instance X in zone us-central1-b".

export type WorkerPrincipal =
  | { kind: "shared_secret" }
  | { kind: "gcp_id_token"; saEmail: string; instanceId?: string; zone?: string };

export type AuthResult =
  | { ok: true; principal: WorkerPrincipal }
  | { ok: false; reason: string };

export interface WorkerAuthStrategy {
  verify(authorizationHeader: string | undefined): Promise<AuthResult>;
}

// Constant-time string equality. timingSafeEqual rejects mismatched lengths
// outright; do that check explicitly and bail before allocating Buffers
// for the comparison so length probes can't measure work done on the
// matching path.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

export function sharedSecretAuthStrategy(opts: { secret: string }): WorkerAuthStrategy {
  return {
    async verify(header) {
      if (!header) return { ok: false, reason: "missing authorization header" };
      const m = /^Bearer\s+(.+)$/.exec(header);
      if (!m) return { ok: false, reason: "expected Bearer scheme" };
      if (!constantTimeEquals(m[1], opts.secret)) {
        return { ok: false, reason: "secret mismatch" };
      }
      return { ok: true, principal: { kind: "shared_secret" } };
    },
  };
}

// Minimal subset of google-auth-library's OAuth2Client.verifyIdToken
// surface we actually depend on. Lets tests inject a fake verifier
// without pulling the full library into test bundles, and decouples our
// code from the library's exact return type.
export interface IdTokenVerifierLike {
  verifyIdToken(opts: {
    idToken: string;
    audience: string;
  }): Promise<{
    getPayload: () => { email?: string; aud?: string; iss?: string } | undefined;
  }>;
}

export interface GcpIdTokenStrategyOpts {
  // Audience claim the worker requested when minting its id-token. The
  // verifier rejects a mismatched `aud` outright. Spec D2: the gRPC
  // service URL or a stable identifier we publish to workers.
  audience: string;
  // Allow-list of service-account emails we accept. A successful JWT
  // signature check still goes through this gate — keeps "any GCP
  // identity in the project" from being equivalent to "anyone who can
  // talk to this server".
  saAllowlist: string[];
  // Production wires a real OAuth2Client; tests inject a fake. Default
  // construction is lazy (dynamic import below) so unit tests that
  // never exercise this strategy don't pay the load cost.
  verifier?: IdTokenVerifierLike;
}

export function gcpIdTokenAuthStrategy(opts: GcpIdTokenStrategyOpts): WorkerAuthStrategy {
  let cachedDefault: IdTokenVerifierLike | undefined;
  const resolveVerifier = async (): Promise<IdTokenVerifierLike> => {
    if (opts.verifier) return opts.verifier;
    if (!cachedDefault) {
      const mod = await import("google-auth-library");
      cachedDefault = new mod.OAuth2Client() as unknown as IdTokenVerifierLike;
    }
    return cachedDefault;
  };
  return {
    async verify(header) {
      if (!header) return { ok: false, reason: "missing authorization header" };
      const m = /^Bearer\s+(.+)$/.exec(header);
      if (!m) return { ok: false, reason: "expected Bearer scheme" };
      let payload: { email?: string; aud?: string } | undefined;
      try {
        const verifier = await resolveVerifier();
        const ticket = await verifier.verifyIdToken({ idToken: m[1], audience: opts.audience });
        payload = ticket.getPayload() ?? undefined;
      } catch (err) {
        return { ok: false, reason: `id-token verification failed: ${(err as Error).message}` };
      }
      if (!payload?.email) return { ok: false, reason: "id-token missing email claim" };
      if (!opts.saAllowlist.includes(payload.email)) {
        return { ok: false, reason: `SA ${payload.email} not in allowlist` };
      }
      return { ok: true, principal: { kind: "gcp_id_token", saEmail: payload.email } };
    },
  };
}
