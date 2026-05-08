import { describe, it, expect, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { RunDispatchSchema, type WorkerToServer } from "@paperclipai/worker-rpc";
import { handleRunDispatch } from "../run-handler.js";

describe("handleRunDispatch", () => {
  it("realizes a workspace, runs the shim, emits Complete, and cleans up", async () => {
    const sent: WorkerToServer[] = [];
    const cleanup = vi.fn(async () => {});
    const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup }));
    const shim = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      summary: "ok",
      usage: { tokens: 1 },
    }));
    const fetchSecrets = vi.fn(async () => ({}));

    await handleRunDispatch(
      create(RunDispatchSchema, {
        runId: "r-1",
        agentId: "a-1",
        adapterType: "pi_local",
        adapterConfigJson: new TextEncoder().encode("{}"),
        executionWorkspaceJson: new TextEncoder().encode("{}"),
        secretsScopeToken: "tok",
        sessionRestore: new Uint8Array(),
        leaseSeconds: 300,
      }),
      {
        realizeWorkspace: realize,
        runAdapter: shim,
        fetchSecrets,
        send: async (m) => {
          sent.push(m);
        },
      },
    );

    expect(realize).toHaveBeenCalledOnce();
    expect(shim).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    const completes = sent.filter((m) => m.payload.case === "runComplete");
    expect(completes.length).toBe(1);
    if (completes[0].payload.case === "runComplete") {
      expect(completes[0].payload.value.exitCode).toBe(0);
    }
  });

  it("emits RunLeaseRenew at lease_seconds/3 cadence and stops when run completes", async () => {
    vi.useFakeTimers();
    const sent: WorkerToServer[] = [];
    const cleanup = vi.fn(async () => {});
    const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup }));

    // Adapter blocks until we resolve it manually so we can advance
    // fake timers and observe keepalive frames mid-run.
    let resolveAdapter!: () => void;
    const adapterDone = new Promise<void>((r) => {
      resolveAdapter = r;
    });
    const shim = vi.fn(async () => {
      await adapterDone;
      return { exitCode: 0, signal: null, summary: "ok" };
    });
    const fetchSecrets = vi.fn(async () => ({}));

    const handlerDone = handleRunDispatch(
      create(RunDispatchSchema, {
        runId: "r-keep",
        agentId: "a-keep",
        adapterType: "claude_local",
        adapterConfigJson: new TextEncoder().encode("{}"),
        executionWorkspaceJson: new TextEncoder().encode("{}"),
        secretsScopeToken: "tok",
        sessionRestore: new Uint8Array(),
        leaseSeconds: 9, // renew interval = 3000ms
      }),
      {
        realizeWorkspace: realize,
        runAdapter: shim,
        fetchSecrets,
        send: async (m) => {
          sent.push(m);
        },
      },
    );

    // Let microtasks settle so the keepalive is armed.
    await vi.advanceTimersByTimeAsync(3000);
    let renews = sent.filter((m) => m.payload.case === "runLeaseRenew");
    expect(renews.length).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    renews = sent.filter((m) => m.payload.case === "runLeaseRenew");
    expect(renews.length).toBe(2);

    resolveAdapter();
    await vi.runAllTimersAsync();
    await handlerDone;

    const before = sent.filter((m) => m.payload.case === "runLeaseRenew").length;
    await vi.advanceTimersByTimeAsync(10_000);
    const after = sent.filter((m) => m.payload.case === "runLeaseRenew").length;
    expect(after).toBe(before);
    vi.useRealTimers();
  });

  it("emits RunFailed on adapter throw, still cleans up", async () => {
    const sent: WorkerToServer[] = [];
    const cleanup = vi.fn(async () => {});
    const realize = vi.fn(async () => ({ cwd: "/tmp/fake", cleanup }));
    const shim = vi.fn(async () => {
      throw new Error("boom");
    });
    const fetchSecrets = vi.fn(async () => ({}));

    await handleRunDispatch(
      create(RunDispatchSchema, {
        runId: "r-2",
        agentId: "a-2",
        adapterType: "pi_local",
        adapterConfigJson: new TextEncoder().encode("{}"),
        executionWorkspaceJson: new TextEncoder().encode("{}"),
        secretsScopeToken: "tok",
        sessionRestore: new Uint8Array(),
        leaseSeconds: 300,
      }),
      {
        realizeWorkspace: realize,
        runAdapter: shim,
        fetchSecrets,
        send: async (m) => {
          sent.push(m);
        },
      },
    );

    const failed = sent.filter((m) => m.payload.case === "runFailed");
    expect(failed.length).toBe(1);
    if (failed[0].payload.case === "runFailed") {
      expect(failed[0].payload.value.error).toContain("boom");
    }
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
