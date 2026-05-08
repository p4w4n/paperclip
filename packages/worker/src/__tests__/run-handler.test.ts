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
