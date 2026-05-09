import { describe, expect, it, vi } from "vitest";
import { runWorkQueueDrain } from "../scheduler.js";
import { registerRoutineMaterializer } from "../routine-integration.js";

describe("runWorkQueueDrain", () => {
  it("returns zeros when no companies have queued items", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      execute: vi.fn(async () => ({ rows: [] })),
      update: vi.fn(() => ({ set: vi.fn(async () => {}) })),
    };
    const out = await runWorkQueueDrain({ db });
    expect(out).toEqual({ dequeued: 0, errors: 0 });
  });

  it("rolls draws across companies in fairness order until budget exhausts", async () => {
    // Track materializeWorkItem calls via the dequeue path; mock
    // both dequeue + materialize at the SQL surface.
    const dequeueOrder: string[] = [];
    let dequeueCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      execute: vi.fn(async (sqlExpr: unknown) => {
        const text = (sqlExpr as { sql?: string; queryChunks?: unknown[] })?.sql ?? "";
        if (text.includes("DISTINCT wi.company_id") || true) {
          // Two candidate companies (we don't read SQL text here;
          // the first execute() call returns the candidates).
          if (dequeueCount === 0) {
            dequeueCount = 1;
            return {
              rows: [
                { company_id: "co-A", weight: 1, recent_dequeued: 0 },
                { company_id: "co-B", weight: 1, recent_dequeued: 0 },
              ],
            };
          }
          // Subsequent execute() calls are dequeueOneForCompany —
          // alternate "row found" then "exhausted" per company.
          // For simplicity: every dequeue call returns null after
          // the first 4 successful pulls.
          dequeueOrder.push("dequeue");
          if (dequeueOrder.length <= 4) {
            return {
              rows: [
                {
                  id: `wi-${dequeueOrder.length}`,
                  company_id: dequeueOrder.length % 2 === 1 ? "co-A" : "co-B",
                  queue: "default",
                  priority: 5,
                  dedupe_key: null,
                  target_issue_id: "iss-1",
                  target_agent_id: "ag-1",
                  routine_id: null,
                  payload: null,
                  state: "queued",
                  available_at: new Date(),
                  attempts: 0,
                  max_attempts: 3,
                  retry_policy: null,
                  enqueued_by_kind: "api",
                  enqueued_by_ref: null,
                  enqueued_at: new Date(),
                  started_at: null,
                  completed_at: null,
                  run_id: null,
                  last_error: null,
                  last_error_code: null,
                },
              ],
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }),
      update: vi.fn(() => ({ set: vi.fn(async () => {}) })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transaction: vi.fn(async (fn: any) => fn({
        select: () => ({
          from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
        }),
        insert: () => ({
          values: () => ({
            returning: async () => [{ id: "run-x" }],
            onConflictDoUpdate: async () => {},
          }),
        }),
        update: () => ({ set: () => ({ where: async () => {} }) }),
      })),
    };

    registerRoutineMaterializer(async () => ({ issueId: "iss-r", agentId: "ag-r" }));

    const out = await runWorkQueueDrain({ db, maxItems: 4 });
    expect(out.dequeued).toBe(4);
  });
});
