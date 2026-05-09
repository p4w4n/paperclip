import { describe, expect, it } from "vitest";
import { ArtifactsTenantMismatchError } from "../types.js";

describe("ArtifactsTenantMismatchError", () => {
  it("includes both ids in the message", () => {
    const err = new ArtifactsTenantMismatchError("co-A", "co-B");
    expect(err.message).toContain("co-A");
    expect(err.message).toContain("co-B");
    expect(err.name).toBe("ArtifactsTenantMismatchError");
  });

  it("is an Error instance", () => {
    expect(new ArtifactsTenantMismatchError("a", "b")).toBeInstanceOf(Error);
  });
});
