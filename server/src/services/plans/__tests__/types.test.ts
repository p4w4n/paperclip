import { describe, expect, it } from "vitest";
import { PlanTenantMismatchError } from "../types.js";

describe("PlanTenantMismatchError", () => {
  it("includes both ids in the message", () => {
    const err = new PlanTenantMismatchError("co-A", "co-B");
    expect(err.message).toContain("co-A");
    expect(err.message).toContain("co-B");
    expect(err.name).toBe("PlanTenantMismatchError");
  });
});
