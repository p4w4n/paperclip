// Routes a worker-side adapter invocation to the right `*_local`
// adapter's existing execute() function. The adapter code itself runs
// unchanged — only the dispatch boundary is new. v1 wires `pi_local`
// only (smallest surface, validates the vertical slice). Other adapters
// hook in via the same switch in subsequent tasks.
//
// The runtime context (cwd, env, agent id, run id) is constructed in
// run-handler.ts; this shim only adapts shape-mismatch and routes by
// adapterType.

import type { AdapterInvocationContext, AdapterOutcome } from "./run-handler.js";

export async function runAdapterOnWorker(
  adapterType: string,
  ctx: AdapterInvocationContext,
): Promise<AdapterOutcome> {
  switch (adapterType) {
    case "pi_local": {
      // Lazy import so the worker package's typecheck doesn't depend on
      // the adapter's full TypeScript project. This also lets the worker
      // start up without crashing on adapter modules it doesn't end up
      // dispatching to.
      const mod = await import("@paperclipai/adapter-pi-local/server");
      // The adapter's execute() signature has more shape than our minimal
      // AdapterInvocationContext — the full context wiring lands when
      // the worker has run-log + session blob + permissions plumbed
      // through. For v1 of this shim, document the gap and keep the
      // call shape compatible by passing what we have plus stubs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (mod as any).execute({
        runId: ctx.runId,
        agent: ctx.agent,
        config: ctx.config,
        cwd: ctx.cwd,
        env: ctx.env,
        context: ctx.context,
      });
      return {
        exitCode: typeof result?.exitCode === "number" ? result.exitCode : 0,
        signal: typeof result?.signal === "string" ? result.signal : null,
        summary: typeof result?.summary === "string" ? result.summary : undefined,
        usage: typeof result?.usage === "object" && result.usage !== null ? result.usage : undefined,
      };
    }
    default:
      // Hard error so the gap surfaces as a worker-side RunFailed rather
      // than a silent no-op that leaves the run hanging.
      throw new Error(`adapter ${adapterType} not yet supported by worker`);
  }
}
