import { describe, expect, it, vi } from "vitest";
import { materializeWorkItem } from "../materialize.js";
import type { WorkItem } from "../types.js";

const baseItem: WorkItem = {
  id: "wi-1",
  companyId: "co-1",
  queue: "default",
  priority: 5,
  dedupeKey: null,
  targetIssueId: null,
  targetAgentId: null,
  routineId: null,
  payload: null,
  state: "queued",
  availableAt: new Date(),
  attempts: 0,
  maxAttempts: 3,
  retryPolicy: null,
  enqueuedByKind: "api",
  enqueuedByRef: null,
  enqueuedAt: new Date(),
  startedAt: null,
  completedAt: null,
  runId: null,
  lastError: null,
  lastErrorCode: null,
};

function makeTx() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    insert: vi.fn((tbl: { name?: string }) => ({
      values: vi.fn((v: Record<string, unknown>) => {
        const tableName = (tbl as unknown as { _: { name: string } })?._?.name ?? "?";
        inserts.push({ table: tableName, values: v });
        return {
          returning: vi.fn(async () => [{ id: "run-new" }]),
          onConflictDoUpdate: vi.fn(async () => {}),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        updates.push({ values: v });
        return { where: vi.fn(async () => {}) };
      }),
    })),
  };
  return { tx, inserts, updates };
}

describe("materializeWorkItem", () => {
  it("inserts a heartbeat_run + transitions the work_item to running", async () => {
    const { tx, inserts, updates } = makeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = { transaction: async (fn: any) => fn(tx) };
    const result = await materializeWorkItem(db, {
      item: { ...baseItem, targetIssueId: "iss-1", targetAgentId: "ag-1" },
    });
    expect(result.runId).toBe("run-new");
    expect(inserts.length).toBeGreaterThan(0); // heartbeat_run + credits upsert
    expect(updates.length).toBe(1); // work_item transition
    expect(updates[0].values.state).toBe("running");
    expect(updates[0].values.runId).toBe("run-new");
  });

  it("uses resolveRoutineTarget when target_issue/agent unset", async () => {
    const { tx } = makeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = { transaction: async (fn: any) => fn(tx) };
    const resolveRoutineTarget = vi.fn(async () => ({ issueId: "iss-r", agentId: "ag-r" }));
    await materializeWorkItem(db, {
      item: { ...baseItem, routineId: "rt-1" },
      resolveRoutineTarget,
    });
    expect(resolveRoutineTarget).toHaveBeenCalledWith("rt-1", null);
  });

  it("throws when neither pre-resolved nor routine resolver is available", async () => {
    const { tx } = makeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = { transaction: async (fn: any) => fn(tx) };
    await expect(
      materializeWorkItem(db, { item: baseItem }),
    ).rejects.toThrow(/neither/);
  });
});
