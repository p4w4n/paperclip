import { describe, expect, it, vi } from "vitest";
import { createWorkQueueService } from "../service.js";
import { WorkQueueTenantMismatchError } from "../types.js";

function fakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        updates.push(v);
        return { where: vi.fn(async () => {}) };
      }),
    })),
    select: vi.fn(),
    insert: vi.fn(),
  };
  return { db, updates };
}

describe("WorkQueueService.cancel", () => {
  it("rejects cross-company calls", async () => {
    const { db } = fakeDb();
    const svc = createWorkQueueService({ db });
    await expect(
      svc.cancel({ callerCompanyId: "co-A" }, { id: "wi-1", companyId: "co-B" }),
    ).rejects.toBeInstanceOf(WorkQueueTenantMismatchError);
  });

  it("transitions to cancelled with completed_at set", async () => {
    const { db, updates } = fakeDb();
    const svc = createWorkQueueService({ db });
    await svc.cancel({ callerCompanyId: "co-1" }, { id: "wi-1", companyId: "co-1" });
    expect(updates).toHaveLength(1);
    expect(updates[0].state).toBe("cancelled");
    expect(updates[0].completedAt).toBeInstanceOf(Date);
  });
});

describe("WorkQueueService.replayDeadLetter", () => {
  it("rejects cross-company calls", async () => {
    const { db } = fakeDb();
    const svc = createWorkQueueService({ db });
    await expect(
      svc.replayDeadLetter({ callerCompanyId: "co-A" }, { id: "wi-1", companyId: "co-B" }),
    ).rejects.toBeInstanceOf(WorkQueueTenantMismatchError);
  });

  it("resets state, attempts, and clears error fields by default", async () => {
    const { db, updates } = fakeDb();
    const svc = createWorkQueueService({ db });
    await svc.replayDeadLetter(
      { callerCompanyId: "co-1" },
      { id: "wi-1", companyId: "co-1" },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].state).toBe("queued");
    expect(updates[0].attempts).toBe(0);
    expect(updates[0].lastError).toBeNull();
  });

  it("resetAttempts=false preserves attempts (uses sql expr)", async () => {
    const { db, updates } = fakeDb();
    const svc = createWorkQueueService({ db });
    await svc.replayDeadLetter(
      { callerCompanyId: "co-1" },
      { id: "wi-1", companyId: "co-1", resetAttempts: false },
    );
    expect(updates[0].attempts).not.toBe(0);
  });
});
