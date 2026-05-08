// Routes a worker-side adapter invocation to the right `*_local`
// adapter's existing execute() function. The adapter code itself runs
// unchanged — only the dispatch boundary is new. v1 wires `claude_local`
// and `gemini_local` (the deployment's actual targets). Other adapters
// drop in via the same switch with no behavioural change.
//
// The runtime context (cwd, env, agent id, run id) is constructed in
// run-handler.ts; this shim only adapts shape-mismatch and routes by
// adapterType. Lazy imports per-case so the worker can boot without
// every adapter module's transitive deps available.

import type { AdapterInvocationContext, AdapterOutcome } from "./run-handler.js";

// Normalises whatever shape the adapter's execute() returns into the
// minimal AdapterOutcome the run-handler emits as RunComplete. Keeps the
// per-adapter blocks below short and uniform.
function normaliseOutcome(result: unknown): AdapterOutcome {
  const r = result as {
    exitCode?: unknown;
    signal?: unknown;
    summary?: unknown;
    usage?: unknown;
  } | null;
  return {
    exitCode: typeof r?.exitCode === "number" ? r.exitCode : 0,
    signal: typeof r?.signal === "string" ? r.signal : null,
    summary: typeof r?.summary === "string" ? r.summary : undefined,
    usage:
      typeof r?.usage === "object" && r?.usage !== null
        ? (r.usage as Record<string, unknown>)
        : undefined,
  };
}

export async function runAdapterOnWorker(
  adapterType: string,
  ctx: AdapterInvocationContext,
): Promise<AdapterOutcome> {
  switch (adapterType) {
    case "claude_local": {
      const mod = await import("@paperclipai/adapter-claude-local/server");
      // Adapter execute() signatures take more shape than this minimal
      // AdapterInvocationContext — log streaming, session blob, and
      // permissions wiring land in subsequent tasks. For now pass what
      // we have plus the adapter handles missing fields by returning
      // a clear failure.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return normaliseOutcome(await (mod as any).execute({
        runId: ctx.runId,
        agent: ctx.agent,
        config: ctx.config,
        cwd: ctx.cwd,
        env: ctx.env,
        context: ctx.context,
      }));
    }
    case "gemini_local": {
      const mod = await import("@paperclipai/adapter-gemini-local/server");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return normaliseOutcome(await (mod as any).execute({
        runId: ctx.runId,
        agent: ctx.agent,
        config: ctx.config,
        cwd: ctx.cwd,
        env: ctx.env,
        context: ctx.context,
      }));
    }
    default:
      // Hard error so the gap surfaces as a worker-side RunFailed
      // rather than a silent no-op that leaves the run hanging.
      throw new Error(`adapter ${adapterType} not yet supported by worker`);
  }
}
