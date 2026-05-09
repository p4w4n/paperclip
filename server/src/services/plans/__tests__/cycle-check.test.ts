import { describe, expect, it } from "vitest";
import { wouldCreateCycle } from "../cycle-check.js";

describe("wouldCreateCycle", () => {
  it("rejects self-loop", () => {
    expect(wouldCreateCycle([], { fromPhaseId: "a", toPhaseId: "a" })).toBe(true);
  });

  it("clean A→B with no existing edges is fine", () => {
    expect(wouldCreateCycle([], { fromPhaseId: "a", toPhaseId: "b" })).toBe(false);
  });

  it("A→B then B→A creates a cycle", () => {
    expect(
      wouldCreateCycle(
        [{ fromPhaseId: "a", toPhaseId: "b" }],
        { fromPhaseId: "b", toPhaseId: "a" },
      ),
    ).toBe(true);
  });

  it("A→B, B→C, then C→A creates a cycle", () => {
    expect(
      wouldCreateCycle(
        [
          { fromPhaseId: "a", toPhaseId: "b" },
          { fromPhaseId: "b", toPhaseId: "c" },
        ],
        { fromPhaseId: "c", toPhaseId: "a" },
      ),
    ).toBe(true);
  });

  it("parallel chains don't cycle", () => {
    expect(
      wouldCreateCycle(
        [
          { fromPhaseId: "a", toPhaseId: "b" },
          { fromPhaseId: "a", toPhaseId: "c" },
        ],
        { fromPhaseId: "b", toPhaseId: "d" },
      ),
    ).toBe(false);
  });

  it("diamond is fine", () => {
    expect(
      wouldCreateCycle(
        [
          { fromPhaseId: "a", toPhaseId: "b" },
          { fromPhaseId: "a", toPhaseId: "c" },
          { fromPhaseId: "b", toPhaseId: "d" },
        ],
        { fromPhaseId: "c", toPhaseId: "d" },
      ),
    ).toBe(false);
  });
});
