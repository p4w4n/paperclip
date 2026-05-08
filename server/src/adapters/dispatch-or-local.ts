// The seam between in-process adapter execution and worker-pool
// dispatch. Wraps an existing adapter's execute() with a pre-execute
// branch: if a worker is registered for this adapter type, route the
// run to the worker pool and wait for completion via the bidi stream;
// otherwise fall back to the original in-process execution.
//
// Same wrapper used for every adapter — this file stays adapter-agnostic.
// adapterType comes in as a prop so the same factory wires claude_local,
// gemini_local, etc.
//
// Spec rationale: "single key seam" — no new adapter type exposed to
// user configuration. The agent's adapterType (e.g., claude_local) stays
// as written; the dispatch decision is invisible to user-authored
// agent configs.

import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunDispatcher } from "../services/run-dispatcher.js";
import type { WorkerRegistry } from "../services/worker-registry.js";

export interface DispatchOrLocalOpts {
  adapterType: string;
  localExecute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  dispatcher: Pick<RunDispatcher, "tryDispatch" | "markCompleted">;
  registry: Pick<WorkerRegistry, "pickFor">;
  // Mints a fresh, one-time-use scope token bound to (runId, agentId)
  // before the dispatch leaves. The worker exchanges this token via
  // FetchSecrets (handled by secrets-handler.ts) for the actual secret
  // material. Spec D2 contract — see scope-token-store.ts.
  // Optional: tests inject vi.fn(); production wiring uses scopeTokenStore.mint.
  // When omitted, falls back to a stub so the seam works for tests that
  // don't exercise the secrets path.
  mintScopeToken?: (input: { runId: string; agentId: string; leaseSeconds: number }) => string;
  // Resolves the agent's secrets at dispatch time. Default is a stub
  // returning {} so the seam stays usable for tests; the production
  // factory in registry.ts plugs in the real per-agent resolution.
  resolveSecretsForAgent?: (agentId: string) => Promise<Record<string, string>>;
  // Resolves once the worker reports RunComplete or RunFailed for the
  // run. Backed by run-completion-registry.ts in production; tests pass
  // a vi.fn(). The wrapper unconditionally calls markCompleted in
  // `finally` so a settle that never arrives still releases the slot
  // when the lease expires (Task 12).
  awaitCompletion: (runId: string) => Promise<AdapterExecutionResult>;
  leaseSeconds?: number;
  // Plan 4 (filestore mode). When BOTH callbacks are provided, the
  // wrapper acquires a workspace lease BEFORE tryDispatch and releases
  // it on completion. If the lease is unavailable, the wrapper throws
  // WorkspaceBusyError so the heartbeat scheduler retries on its next
  // tick — natural serialization without an explicit queue. When
  // omitted (the common ephemeral-mode case), the wrapper behaves
  // exactly as Plans 1-3.
  acquireWorkspaceLease?: (input: { runId: string; agentId: string; leaseSeconds: number }) => Promise<
    | { acquired: true; leaseId: string }
    | { acquired: false; currentHolderRunId: string | null; currentHolderWorkerId: string | null }
  >;
  releaseWorkspaceLease?: (input: { leaseId: string }) => Promise<void>;
}

export class WorkspaceBusyError extends Error {
  constructor(public readonly currentHolder: { runId: string | null; workerId: string | null }) {
    super(
      `workspace_busy (currentHolder run=${currentHolder.runId ?? "?"} worker=${currentHolder.workerId ?? "?"})`,
    );
    this.name = "WorkspaceBusyError";
  }
}

export class DispatchFailedError extends Error {
  constructor(reason: string) {
    super(`dispatch_failed (${reason})`);
    this.name = "DispatchFailedError";
  }
}

export interface DispatchOrLocalAdapter {
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
}

export function createDispatchOrLocal(opts: DispatchOrLocalOpts): DispatchOrLocalAdapter {
  return {
    async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
      // Two fall-back-to-local paths:
      //   1. No worker is registered for this adapterType.
      //   2. A worker was picked but the dispatch send failed (stream
      //      broke between pickFor and write). The dispatcher reports
      //      `dispatched: false` in that case.
      // Both fall back to local execution rather than returning an
      // error — keeps the OSS single-host story working unchanged.
      const worker = opts.registry.pickFor(opts.adapterType);
      if (!worker) {
        // No worker available. In filestore mode this is fatal — we
        // can't fall back to local because the in-process path would
        // race the lease holder on the same files. The heartbeat
        // scheduler retries via its tick.
        if (opts.acquireWorkspaceLease) {
          throw new DispatchFailedError("no_worker_available");
        }
        return opts.localExecute(ctx);
      }

      const leaseSecondsForBoth = opts.leaseSeconds ?? 300;

      // Plan 4: in filestore mode, the workspace lock is acquired
      // before dispatch. Busy → throw; the scheduler's next tick
      // retries naturally. Send-failure later in this function rolls
      // back the lease.
      let workspaceLeaseId: string | null = null;
      if (opts.acquireWorkspaceLease) {
        const r = await opts.acquireWorkspaceLease({
          runId: ctx.runId,
          agentId: ctx.agent.id,
          leaseSeconds: leaseSecondsForBoth,
        });
        if (!r.acquired) {
          throw new WorkspaceBusyError({
            runId: r.currentHolderRunId,
            workerId: r.currentHolderWorkerId,
          });
        }
        workspaceLeaseId = r.leaseId;
      }

      // Resolve the agent's secrets BEFORE minting the token so the
      // store entry carries the actual values. The worker's later
      // FetchSecrets call then becomes a pure lookup, no DB roundtrip.
      const resolveSecrets = opts.resolveSecretsForAgent ?? (async () => ({}));
      const secrets = await resolveSecrets(ctx.agent.id);
      const leaseSeconds = leaseSecondsForBoth;
      const mint = opts.mintScopeToken ?? (() => `secrets-stub:${ctx.runId}`);
      const scopeToken = mint({
        runId: ctx.runId,
        agentId: ctx.agent.id,
        leaseSeconds,
      });
      // The mint side may have stored the secrets internally; for the
      // injected version with a real scopeTokenStore we still need to
      // call the store's mint with the resolved secrets. The opts
      // shape here only takes (runId, agentId, leaseSeconds) so the
      // production factory wires `mintScopeToken` to a closure that
      // captures `secrets` per call.
      void secrets;
      const receipt = await opts.dispatcher.tryDispatch({
        runId: ctx.runId,
        agentId: ctx.agent.id,
        adapterType: opts.adapterType,
        adapterConfig: (ctx.config ?? {}) as Record<string, unknown>,
        // Worker side decodes executionWorkspace via realizeWorkspace().
        // For now we pass ctx.context as the descriptor; the workspace
        // lifecycle plumbing (Task 11+) refines this once the worker
        // has the full ExecutionWorkspaceInput shape it needs.
        executionWorkspace: (ctx.context ?? {}) as Record<string, unknown>,
        secretsScopeToken: scopeToken,
        leaseSeconds,
      });
      if (!receipt.dispatched) {
        // Filestore mode: dispatch send failed AFTER we acquired the
        // workspace lease. Roll back so the next attempt can acquire.
        if (workspaceLeaseId !== null && opts.releaseWorkspaceLease) {
          await opts.releaseWorkspaceLease({ leaseId: workspaceLeaseId });
        }
        if (opts.acquireWorkspaceLease) {
          throw new DispatchFailedError(receipt.reason ?? "unknown");
        }
        return opts.localExecute(ctx);
      }

      try {
        return await opts.awaitCompletion(ctx.runId);
      } finally {
        opts.dispatcher.markCompleted(ctx.runId);
        if (workspaceLeaseId !== null && opts.releaseWorkspaceLease) {
          // Best-effort: a failing release is logged inside the
          // production wire's closure; the workspace-lease reaper from
          // P4-3 also catches stuck rows.
          await opts.releaseWorkspaceLease({ leaseId: workspaceLeaseId }).catch(() => {});
        }
      }
    },
  };
}
