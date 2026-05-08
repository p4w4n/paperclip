// In-memory store of dispatch-scoped secret tokens. Spec D2 contract:
//
//   - One-time-use: lookup atomically deletes the entry. A second
//     consume with the same token throws.
//   - Bound to a specific runId / agentId.
//   - Time-boxed to the run's lease window — entries past `expiresAt`
//     reject with "expired" rather than returning stale secrets.
//   - Issued only at RunDispatch time, by the same control plane that
//     issued the dispatch.
//
// State is in-memory; survives the lease window comfortably for the
// happy-path (worker fetches secrets within seconds of receiving
// RunDispatch). Control-plane restart between dispatch and fetch loses
// the entry — the worker's FetchSecrets call then errors, the
// dispatched run fails fast, and the lease reaper (Task 12) requeues.
// That's an acceptable failure mode; persistent backing is queued for
// a deployment where mid-run control-plane restarts are common enough
// to plan for.
//
// The mint side is called by the run dispatcher just before it sends
// RunDispatch to the worker. The consume side is called by
// secrets-handler.ts on the worker's FetchSecrets RPC.

import { randomBytes } from "node:crypto";

interface ScopeTokenEntry {
  runId: string;
  agentId: string;
  expiresAt: number; // ms epoch
  secrets: Record<string, string>;
}

export interface ScopeTokenStore {
  // Mints a new scope token and stores the resolved secrets. Returns
  // the opaque token string that goes in the RunDispatch frame.
  mint: (input: { runId: string; agentId: string; secrets: Record<string, string>; leaseSeconds: number }) => string;
  // Atomically reads and deletes a token. Throws if unknown, expired,
  // or already consumed. Single call per token.
  lookupAndInvalidate: (token: string) => Promise<Record<string, string>>;
  // Visible for testing — drops every entry. Not used in production
  // code paths.
  clearForTest: () => void;
}

export function createScopeTokenStore(): ScopeTokenStore {
  const tokens = new Map<string, ScopeTokenEntry>();

  function newToken(): string {
    // 32 random bytes → ~43 chars base64url. Plenty of entropy; not
    // worth pulling in jsonwebtoken just for this.
    return `scope_${randomBytes(32).toString("base64url")}`;
  }

  return {
    mint({ runId, agentId, secrets, leaseSeconds }) {
      const token = newToken();
      tokens.set(token, {
        runId,
        agentId,
        // Add a 30s buffer beyond the lease so a worker that started a
        // late fetch doesn't get a "lease just expired" surprise.
        expiresAt: Date.now() + (leaseSeconds + 30) * 1000,
        secrets,
      });
      return token;
    },

    async lookupAndInvalidate(token) {
      const entry = tokens.get(token);
      if (!entry) throw new Error("scope token unknown or already consumed");
      // Delete BEFORE returning so a concurrent second call (e.g.,
      // worker retry crossed with the original) sees the absence.
      tokens.delete(token);
      if (Date.now() > entry.expiresAt) {
        throw new Error("scope token expired");
      }
      return entry.secrets;
    },

    clearForTest() {
      tokens.clear();
    },
  };
}

// Module singleton — one store per control-plane process. The
// dispatch-or-local wrapper and the gRPC handler import this directly.
// Tests instantiate fresh stores via createScopeTokenStore().
export const scopeTokenStore = createScopeTokenStore();
