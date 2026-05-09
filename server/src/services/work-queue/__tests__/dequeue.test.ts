import { describe, expect, it, vi } from "vitest";
import { dequeueOneForCompany } from "../dequeue.js";

function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn(async () => ({ rows })) as any,
  };
}

const baseRow = {
  id: "wi-1",
  company_id: "co-1",
  queue: "default",
  priority: 5,
  dedupe_key: null,
  target_issue_id: "iss-1",
  target_agent_id: null,
  routine_id: null,
  payload: null,
  state: "queued",
  available_at: new Date("2026-05-15T10:00:00Z"),
  attempts: 0,
  max_attempts: 3,
  retry_policy: null,
  enqueued_by_kind: "api",
  enqueued_by_ref: null,
  enqueued_at: new Date("2026-05-15T09:59:50Z"),
  started_at: null,
  completed_at: null,
  run_id: null,
  last_error: null,
  last_error_code: null,
};

describe("dequeueOneForCompany", () => {
  it("returns null when no rows match", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb([]) as any;
    const out = await dequeueOneForCompany({ db, companyId: "co-1", queue: "default" });
    expect(out).toBeNull();
  });

  it("hydrates a WorkItem when a row is locked", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb([baseRow]) as any;
    const out = await dequeueOneForCompany({ db, companyId: "co-1", queue: "default" });
    expect(out).not.toBeNull();
    expect(out?.id).toBe("wi-1");
    expect(out?.targetIssueId).toBe("iss-1");
    expect(out?.state).toBe("queued");
  });
});
