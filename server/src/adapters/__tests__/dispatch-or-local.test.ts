import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDispatchOrLocal } from "../dispatch-or-local.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function ctx(runId: string): AdapterExecutionContext {
  // Minimal stub — the wrapper only reads runId, agent.id, config, and
  // context. The full AdapterExecutionContext shape has many more fields
  // that don't affect the dispatch decision.
  return {
    runId,
    agent: { id: `agent-${runId}` },
    config: {},
    context: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AdapterExecutionContext;
}

describe("createDispatchOrLocal", () => {
  let localExec: ReturnType<typeof vi.fn>;
  let dispatcher: { tryDispatch: ReturnType<typeof vi.fn>; markCompleted: ReturnType<typeof vi.fn> };
  let registry: { pickFor: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localExec = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "local" }));
    dispatcher = { tryDispatch: vi.fn(), markCompleted: vi.fn() };
    registry = { pickFor: vi.fn() };
  });

  it("falls back to local when no worker available", async () => {
    registry.pickFor.mockReturnValue(null);
    const adapter = createDispatchOrLocal({
      adapterType: "claude_local",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      localExecute: localExec as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: dispatcher as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      awaitCompletion: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "remote" }),
    });
    const res = await adapter.execute(ctx("r1"));
    expect(res.summary).toBe("local");
    expect(localExec).toHaveBeenCalled();
  });

  it("dispatches to worker when available and waits for completion", async () => {
    registry.pickFor.mockReturnValue({ workerId: "w1" });
    dispatcher.tryDispatch.mockResolvedValue({ dispatched: true, workerId: "w1" });
    const awaitCompletion = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "remote",
    }));
    const adapter = createDispatchOrLocal({
      adapterType: "claude_local",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      localExecute: localExec as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: dispatcher as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      awaitCompletion,
    });
    const res = await adapter.execute(ctx("r2"));
    expect(res.summary).toBe("remote");
    expect(localExec).not.toHaveBeenCalled();
    expect(dispatcher.markCompleted).toHaveBeenCalledWith("r2");
  });

  it("falls back to local when dispatcher reports send failure", async () => {
    registry.pickFor.mockReturnValue({ workerId: "w1" });
    dispatcher.tryDispatch.mockResolvedValue({ dispatched: false, reason: "send failed" });
    const awaitCompletion = vi.fn();
    const adapter = createDispatchOrLocal({
      adapterType: "gemini_local",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      localExecute: localExec as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: dispatcher as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: registry as any,
      awaitCompletion,
    });
    const res = await adapter.execute(ctx("r3"));
    expect(res.summary).toBe("local");
    expect(awaitCompletion).not.toHaveBeenCalled();
  });
});
