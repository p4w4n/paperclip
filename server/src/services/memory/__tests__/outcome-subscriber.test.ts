// Tests for the memory outcome subscriber.
// Verifies that procedural memory entries are written on outcome.verified
// and outcome.reverted events, and that failures are swallowed (best-effort).

import { describe, expect, it, vi } from "vitest";
import { attachMemoryOutcomeSubscriber } from "../outcome-subscriber.js";
import type { MemoryService } from "../service.js";

function fakeMemory(): MemoryService {
  return {
    write: vi.fn(async () => ({ id: "mem-1" })),
  } as unknown as MemoryService;
}

describe("memory outcome subscriber", () => {
  it("inserts a procedural memory entry on outcome.verified", async () => {
    const memory = fakeMemory();
    const sub = attachMemoryOutcomeSubscriber(memory);

    await sub.onVerified({
      kind: "artifact_declared",
      targetKind: "issue",
      targetId: "iss-1",
      companyId: "co-1",
    });

    expect(memory.write).toHaveBeenCalledOnce();
    const [ctx, input] = (memory.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctx.callerCompanyId).toBe("co-1");
    expect(input.kind).toBe("procedural");
    expect(input.content).toMatch(/Outcome verified/);
    expect(input.scope.companyId).toBe("co-1");
  });

  it("inserts a procedural memory entry on outcome.reverted", async () => {
    const memory = fakeMemory();
    const sub = attachMemoryOutcomeSubscriber(memory);

    await sub.onReverted({
      kind: "approval_granted",
      targetKind: "plan",
      targetId: "plan-1",
      companyId: "co-2",
      reason: "operator override",
    });

    expect(memory.write).toHaveBeenCalledOnce();
    const [ctx, input] = (memory.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctx.callerCompanyId).toBe("co-2");
    expect(input.kind).toBe("procedural");
    expect(input.content).toMatch(/Outcome reverted/);
    expect(input.scope.companyId).toBe("co-2");
  });

  it("swallows errors from memory.write (best-effort)", async () => {
    const memory = fakeMemory();
    (memory.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const sub = attachMemoryOutcomeSubscriber(memory);

    // Should not throw even when write fails.
    await expect(
      sub.onVerified({
        kind: "plan_completed",
        targetKind: "plan",
        targetId: "plan-2",
        companyId: "co-3",
      }),
    ).resolves.not.toThrow();
  });
});

describe("memory outcome subscriber — auto-reopen events", () => {
  it("records a procedural memory entry when an outcome revert reopens the parent", async () => {
    const memory = fakeMemory();
    const sub = attachMemoryOutcomeSubscriber(memory);

    await sub.onReverted({
      kind: "approval_granted",
      targetKind: "task",
      targetId: "task-42",
      companyId: "co-4",
      reason: "reverted by operator",
      parentReopened: true,
    });

    // Two writes: one for the revert itself, one for the auto-reopen.
    expect(memory.write).toHaveBeenCalledTimes(2);

    const calls = (memory.write as ReturnType<typeof vi.fn>).mock.calls;

    // First call: standard reverted entry.
    expect(calls[0][1].content).toMatch(/Outcome reverted/);

    // Second call: auto-reopen procedural entry.
    const [ctx, input] = calls[1];
    expect(ctx.callerCompanyId).toBe("co-4");
    expect(input.kind).toBe("procedural");
    expect(input.content).toMatch(/auto-reopen|reopened/i);
    expect(input.scope.companyId).toBe("co-4");
  });

  it("does NOT record an extra entry when parentReopened is false", async () => {
    const memory = fakeMemory();
    const sub = attachMemoryOutcomeSubscriber(memory);

    await sub.onReverted({
      kind: "approval_granted",
      targetKind: "task",
      targetId: "task-43",
      companyId: "co-5",
      reason: "normal revert",
      parentReopened: false,
    });

    // Only one write: the standard reverted entry.
    expect(memory.write).toHaveBeenCalledOnce();
    const [, input] = (memory.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.content).toMatch(/Outcome reverted/);
  });
});
