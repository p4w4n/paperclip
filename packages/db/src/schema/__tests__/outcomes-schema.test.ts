import { describe, expect, it } from "vitest";
import { outcomes } from "../outcomes.js";
import { issues, plans, routines, companies } from "../index.js";

describe("outcomes schema", () => {
  it("exports an outcomes table with the expected columns", () => {
    const cols = Object.keys(outcomes);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "companyId", "targetKind", "targetId", "kind", "status",
        "requiredMeta", "verifiedMeta", "verifiedAt",
        "verifiedByKind", "verifiedById",
        "revertedAt", "revertedReason",
        "createdAt", "updatedAt",
      ]),
    );
  });

  it("adds requiredOutcomes column to issues, plans; defaultRequiredOutcomes to routines; outcomeSignalSecret to companies", () => {
    expect(Object.keys(issues)).toContain("requiredOutcomes");
    expect(Object.keys(plans)).toContain("requiredOutcomes");
    expect(Object.keys(routines)).toContain("defaultRequiredOutcomes");
    expect(Object.keys(companies)).toContain("outcomeSignalSecret");
  });
});
