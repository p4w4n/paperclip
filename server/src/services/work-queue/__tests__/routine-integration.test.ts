import { describe, expect, it, vi } from "vitest";
import {
  enqueueRoutineFiring,
  registerRoutineMaterializer,
  getRoutineMaterializer,
  shouldEnqueueViaWorkQueue,
  type RoutineForEnqueue,
} from "../routine-integration.js";

const baseRoutine: RoutineForEnqueue = {
  id: "rt-1",
  companyId: "co-1",
  enqueueViaWorkQueue: true,
  defaultRetryPolicy: null,
  assigneeAgentId: "ag-1",
};

describe("shouldEnqueueViaWorkQueue", () => {
  it("returns the flag", () => {
    expect(shouldEnqueueViaWorkQueue(baseRoutine)).toBe(true);
    expect(shouldEnqueueViaWorkQueue({ ...baseRoutine, enqueueViaWorkQueue: false })).toBe(false);
  });
});

describe("enqueueRoutineFiring", () => {
  it("calls svc.enqueue with routine_id + assignee + retry policy", async () => {
    const svc = { enqueue: vi.fn(async () => ({ enqueued: true, workItemId: "wi-1" })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enqueueRoutineFiring(svc as any, { callerCompanyId: "co-1" }, {
      routine: { ...baseRoutine, defaultRetryPolicy: { backoff_cap_ms: 1000 } },
      payload: { foo: "bar" },
      dedupeKey: "routine-rt-1-tick-42",
    });
    expect(result.enqueued).toBe(true);
    const calls = svc.enqueue.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>;
    expect(calls[0][1]).toMatchObject({
      companyId: "co-1",
      routineId: "rt-1",
      targetAgentId: "ag-1",
      dedupeKey: "routine-rt-1-tick-42",
      retryPolicy: { backoff_cap_ms: 1000 },
      enqueuedByKind: "routine",
      payload: { foo: "bar" },
    });
  });
});

describe("registerRoutineMaterializer", () => {
  it("throws before registration", () => {
    // re-register a known materializer first (other tests pollute)
    registerRoutineMaterializer(undefined as never);
    expect(() => getRoutineMaterializer()).toThrow(/not registered/);
  });

  it("returns the registered fn", async () => {
    const fn = vi.fn(async () => ({ issueId: "iss-1", agentId: "ag-1" }));
    registerRoutineMaterializer(fn);
    const got = getRoutineMaterializer();
    await got("rt-1", null);
    expect(fn).toHaveBeenCalledWith("rt-1", null);
  });
});
