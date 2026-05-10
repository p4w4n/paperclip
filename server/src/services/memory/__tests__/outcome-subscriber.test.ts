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
