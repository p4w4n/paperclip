import { describe, expect, it } from "vitest";
import { LearningTenantMismatchError } from "../types.js";

describe("LearningTenantMismatchError", () => {
  it("includes both ids in the message", () => {
    const err = new LearningTenantMismatchError("co-A", "co-B");
    expect(err.message).toContain("co-A");
    expect(err.message).toContain("co-B");
    expect(err.name).toBe("LearningTenantMismatchError");
  });
});
