import { describe, expect, it } from "vitest";
import { computeDrawOrder } from "../fairness.js";

describe("computeDrawOrder", () => {
  it("returns empty for empty input", () => {
    expect(computeDrawOrder([])).toEqual([]);
  });

  it("equal weight + zero recent → deterministic by companyId", () => {
    const out = computeDrawOrder([
      { companyId: "co-B", weight: 1, recentDequeued: 0 },
      { companyId: "co-A", weight: 1, recentDequeued: 0 },
    ]);
    expect(out).toEqual(["co-A", "co-B"]);
  });

  it("higher weight ranks first", () => {
    const out = computeDrawOrder([
      { companyId: "co-1", weight: 1, recentDequeued: 0 },
      { companyId: "co-2", weight: 2, recentDequeued: 0 },
    ]);
    expect(out).toEqual(["co-2", "co-1"]);
  });

  it("recent_dequeued penalizes the recently-drawn company", () => {
    const out = computeDrawOrder([
      { companyId: "co-1", weight: 2, recentDequeued: 2 }, // credits = 0
      { companyId: "co-2", weight: 1, recentDequeued: 0 }, // credits = 1
    ]);
    expect(out).toEqual(["co-2", "co-1"]);
  });

  it("ties by credits broken by lowest recent_dequeued", () => {
    const out = computeDrawOrder([
      { companyId: "co-1", weight: 3, recentDequeued: 2 }, // credits=1
      { companyId: "co-2", weight: 1, recentDequeued: 0 }, // credits=1
    ]);
    expect(out[0]).toBe("co-2"); // lower recent_dequeued wins
  });
});
