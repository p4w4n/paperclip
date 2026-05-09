import { describe, expect, it } from "vitest";
import { WorkQueueTenantMismatchError } from "../types.js";

describe("WorkQueueTenantMismatchError", () => {
  it("includes both ids in the message", () => {
    const err = new WorkQueueTenantMismatchError("co-A", "co-B");
    expect(err.message).toContain("co-A");
    expect(err.message).toContain("co-B");
    expect(err.name).toBe("WorkQueueTenantMismatchError");
  });
});
