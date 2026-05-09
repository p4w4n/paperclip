import { describe, expect, it, vi } from "vitest";
import { patternMinerTick } from "../pattern-miner-tick.js";

function makeDb({
  recentRuns,
  existingPattern,
}: {
  recentRuns: Array<{ id: string; companyId: string; contextSnapshot: Record<string, unknown> }>;
  existingPattern?: Record<string, unknown>;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let selectCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        // Recent-runs path: select(...).from(...).where(...).limit(...)
        // Existing-pattern path: select().from(...).where(...).orderBy(...).limit(1)
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              selectCount++;
              return recentRuns;
            }),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => (existingPattern ? [existingPattern] : [])),
            })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        inserts.push(v);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        updates.push(v);
        return { where: vi.fn(async () => {}) };
      }),
    })),
  };
  return { db, inserts, updates, getSelectCount: () => selectCount };
}

describe("patternMinerTick", () => {
  it("returns zero on empty input", async () => {
    const { db } = makeDb({ recentRuns: [] });
    const out = await patternMinerTick({ db });
    expect(out).toEqual({ clustersFound: 0, rowsInserted: 0, rowsUpdated: 0, errors: 0 });
  });

  it("inserts a new pattern when cluster is fresh", async () => {
    const { db, inserts } = makeDb({
      recentRuns: [
        { id: "r1", companyId: "co-1", contextSnapshot: { issueTitle: "Deploy to staging failed" } },
        { id: "r2", companyId: "co-1", contextSnapshot: { issueTitle: "Staging deploy fail" } },
        { id: "r3", companyId: "co-1", contextSnapshot: { issueTitle: "deploy staging failed" } },
      ],
    });
    const out = await patternMinerTick({ db, minClusterSize: 3 });
    expect(out.rowsInserted).toBe(1);
    expect(out.clustersFound).toBe(1);
    expect(inserts[0].clusterSize).toBe(3);
    expect((inserts[0].exemplarRunIds as string[]).length).toBe(3);
  });

  it("updates existing pattern when signature collides", async () => {
    const { db, inserts, updates } = makeDb({
      recentRuns: [
        { id: "r1", companyId: "co-1", contextSnapshot: { issueTitle: "Deploy to staging failed" } },
        { id: "r2", companyId: "co-1", contextSnapshot: { issueTitle: "Staging deploy fail" } },
        { id: "r3", companyId: "co-1", contextSnapshot: { issueTitle: "deploy staging failed" } },
      ],
      existingPattern: {
        id: "pat-1",
        clusterSize: 5,
        exemplarRunIds: ["old1", "old2"],
      },
    });
    const out = await patternMinerTick({ db, minClusterSize: 3 });
    expect(out.rowsUpdated).toBe(1);
    expect(out.rowsInserted).toBe(0);
    expect(updates[0].clusterSize).toBe(8);
    expect(inserts).toHaveLength(0);
  });
});
