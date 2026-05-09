import { describe, expect, it, vi } from "vitest";
import { createWorkQueueService } from "../service.js";
import { WorkQueueTenantMismatchError } from "../types.js";

function fakeDb({
  insertReturning,
  selectExisting,
}: {
  insertReturning: Array<{ id: string }>;
  selectExisting?: Array<{ id: string }>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => insertReturning),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectExisting ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {}),
      })),
    })),
  };
  return db;
}

describe("WorkQueueService.enqueue", () => {
  it("rejects cross-company calls", async () => {
    const svc = createWorkQueueService({ db: fakeDb({ insertReturning: [] }) });
    await expect(
      svc.enqueue(
        { callerCompanyId: "co-A" },
        {
          companyId: "co-B",
          targetIssueId: "iss-1",
          enqueuedByKind: "api",
        },
      ),
    ).rejects.toBeInstanceOf(WorkQueueTenantMismatchError);
  });

  it("rejects priority out of range", async () => {
    const svc = createWorkQueueService({ db: fakeDb({ insertReturning: [] }) });
    await expect(
      svc.enqueue(
        { callerCompanyId: "co-1" },
        {
          companyId: "co-1",
          priority: 99,
          targetIssueId: "iss-1",
          enqueuedByKind: "api",
        },
      ),
    ).rejects.toThrow(/priority/);
  });

  it("rejects when no target/routine is set", async () => {
    const svc = createWorkQueueService({ db: fakeDb({ insertReturning: [] }) });
    await expect(
      svc.enqueue(
        { callerCompanyId: "co-1" },
        { companyId: "co-1", enqueuedByKind: "api" },
      ),
    ).rejects.toThrow(/target/i);
  });

  it("returns enqueued=true on clean insert", async () => {
    const svc = createWorkQueueService({
      db: fakeDb({ insertReturning: [{ id: "wi-1" }] }),
    });
    const result = await svc.enqueue(
      { callerCompanyId: "co-1" },
      {
        companyId: "co-1",
        targetIssueId: "iss-1",
        enqueuedByKind: "api",
      },
    );
    expect(result).toEqual({ enqueued: true, workItemId: "wi-1" });
  });

  it("returns duplicate when dedupe-key collides", async () => {
    const svc = createWorkQueueService({
      db: fakeDb({
        insertReturning: [], // ON CONFLICT absorbed
        selectExisting: [{ id: "wi-existing" }],
      }),
    });
    const result = await svc.enqueue(
      { callerCompanyId: "co-1" },
      {
        companyId: "co-1",
        dedupeKey: "stripe-evt-123",
        targetIssueId: "iss-1",
        enqueuedByKind: "webhook",
      },
    );
    expect(result).toEqual({
      enqueued: false,
      workItemId: "wi-existing",
      reason: "duplicate",
      existingId: "wi-existing",
    });
  });
});
