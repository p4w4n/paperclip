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
  // Resolves once the worker reports RunComplete or RunFailed for the
  // run. Backed by run-completion-registry.ts in production; tests pass
  // a vi.fn(). The wrapper unconditionally calls markCompleted in
  // `finally` so a settle that never arrives still releases the slot
  // when the lease expires (Task 12).
  awaitCompletion: (runId: string) => Promise<AdapterExecutionResult>;
  leaseSeconds?: number;
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
      if (!worker) return opts.localExecute(ctx);

      const receipt = await opts.dispatcher.tryDispatch({
        runId: ctx.runId,
        agentId: ctx.agent.id,
        adapterType: opts.adapterType,
        adapterConfig: (ctx.config ?? {}) as Record<string, unknown>,
        // Worker side decodes executionWorkspace via realizeWorkspace().
        // For now we pass ctx.context as the descriptor; Task 11+ will
        // pass a proper ExecutionWorkspaceInput shape after the
        // workspace lifecycle is plumbed end-to-end.
        executionWorkspace: (ctx.context ?? {}) as Record<string, unknown>,
        // Stub scope token — Task 11 mints a real one tied to the run +
        // agent permissions. Until then the worker's fetchSecrets stub
        // returns {} so adapters that need credentials fail clearly
        // rather than running with bogus values.
        secretsScopeToken: `secrets:${ctx.runId}`,
        leaseSeconds: opts.leaseSeconds ?? 300,
      });
      if (!receipt.dispatched) return opts.localExecute(ctx);

      try {
        return await opts.awaitCompletion(ctx.runId);
      } finally {
        opts.dispatcher.markCompleted(ctx.runId);
      }
    },
  };
}
