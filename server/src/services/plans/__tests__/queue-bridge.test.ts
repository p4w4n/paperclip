import { describe, expect, it, vi } from "vitest";
import { enqueuePhaseWork, resolvePhaseTarget } from "../queue-bridge.js";

function fakeDb({
  phaseRow,
  planRow,
}: {
  phaseRow?: Record<string, unknown> | null;
  planRow?: Record<string, unknown> | null;
}) {
  let call = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    select: vi.fn(() => ({
      from: vi.fn((tbl) => ({
        where: vi.fn(() => {
          call++;
          const tableName = (tbl as { _: { name: string } } | undefined)?._?.name;
          if (tableName === "plan_phases") return Promise.resolve(phaseRow ? [phaseRow] : []);
          if (tableName === "plans") return Promise.resolve(planRow ? [planRow] : []);
          return Promise.resolve([]);
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => {}),
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("enqueuePhaseWork", () => {
  it("calls workQueue.enqueue with planContext payload + dedupeKey", async () => {
    const db = fakeDb({
      phaseRow: { id: "ph-1", planId: "p-1", assigneeAgentId: "ag-1" },
      planRow: { id: "p-1", companyId: "co-1", issueId: "iss-1" },
    });
    const wq = {
      enqueue: vi.fn(async () => ({ enqueued: true, workItemId: "wi-1" })),
      cancel: vi.fn(),
      replayDeadLetter: vi.fn(),
      list: vi.fn(),
      getDepth: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await enqueuePhaseWork(db, wq as any, {
      planId: "p-1",
      phaseId: "ph-1",
    });
    expect(out).toEqual({ enqueued: true, workItemId: "wi-1" });
    const callArgs = wq.enqueue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArgs.dedupeKey).toBe("plan-p-1-phase-ph-1");
    expect((callArgs.payload as Record<string, unknown>).planContext).toEqual({
      planId: "p-1",
      phaseId: "ph-1",
    });
    expect(callArgs.targetIssueId).toBe("iss-1");
    expect(callArgs.targetAgentId).toBe("ag-1");
  });

  it("throws when phase not found", async () => {
    const db = fakeDb({ phaseRow: null });
    const wq = { enqueue: vi.fn() } as unknown as Parameters<typeof enqueuePhaseWork>[1];
    await expect(
      enqueuePhaseWork(db, wq, { planId: "p-1", phaseId: "ph-x" }),
    ).rejects.toThrow(/phase/);
  });
});

describe("resolvePhaseTarget", () => {
  it("returns (issueId, agentId) when both are set", async () => {
    const db = fakeDb({
      phaseRow: { planId: "p-1", assigneeAgentId: "ag-1" },
      planRow: { issueId: "iss-1" },
    });
    const out = await resolvePhaseTarget(db, { planId: "p-1", phaseId: "ph-1" });
    expect(out).toEqual({ issueId: "iss-1", agentId: "ag-1" });
  });

  it("returns null when phase has no assignee", async () => {
    const db = fakeDb({
      phaseRow: { planId: "p-1", assigneeAgentId: null },
      planRow: { issueId: "iss-1" },
    });
    const out = await resolvePhaseTarget(db, { planId: "p-1", phaseId: "ph-1" });
    expect(out).toBeNull();
  });

  it("returns null when plan has no issueId", async () => {
    const db = fakeDb({
      phaseRow: { planId: "p-1", assigneeAgentId: "ag-1" },
      planRow: { issueId: null },
    });
    const out = await resolvePhaseTarget(db, { planId: "p-1", phaseId: "ph-1" });
    expect(out).toBeNull();
  });
});
