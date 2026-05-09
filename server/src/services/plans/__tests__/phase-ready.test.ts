import { describe, expect, it } from "vitest";
import { phaseReadiness } from "../phase-ready.js";

describe("phaseReadiness", () => {
  it("ready when no deps", () => {
    expect(phaseReadiness({ depStatuses: [] })).toBe("ready");
  });
  it("ready when all deps completed", () => {
    expect(
      phaseReadiness({ depStatuses: ["completed", "completed"] }),
    ).toBe("ready");
  });
  it("pending when any dep is in flight", () => {
    expect(
      phaseReadiness({ depStatuses: ["completed", "in_progress"] }),
    ).toBe("pending");
    expect(
      phaseReadiness({ depStatuses: ["pending", "completed"] }),
    ).toBe("pending");
  });
  it("blocked when any dep is skipped or blocked", () => {
    expect(
      phaseReadiness({ depStatuses: ["completed", "skipped"] }),
    ).toBe("blocked");
    expect(
      phaseReadiness({ depStatuses: ["blocked", "in_progress"] }),
    ).toBe("blocked");
  });
});
