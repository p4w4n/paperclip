import { describe, expect, it } from "vitest";
import { shouldReopenParent } from "../reopen-on-revert.js";

describe("shouldReopenParent", () => {
  it("returns true when flag is set and no sibling covers the slot", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: true },
      status: "reverted",
    };
    const siblings: any[] = [];
    expect(shouldReopenParent(reverted as any, siblings)).toEqual({ reopen: true });
  });

  it("returns false when flag is not set", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci" },  // no flag
      status: "reverted",
    };
    expect(shouldReopenParent(reverted as any, []).reopen).toBe(false);
  });

  it("returns false when an alternative is still verified (slot covered)", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: true },
      status: "reverted",
    };
    const siblings = [
      { kind: "manual_signoff", requiredMeta: { name: "ci:alt:0" }, status: "verified" },
    ];
    expect(shouldReopenParent(reverted as any, siblings)).toEqual({
      reopen: false, reason: "alt_covers",
    });
  });

  it("returns false when flag is explicitly false", () => {
    const reverted = {
      kind: "external_signal",
      requiredMeta: { name: "ci", auto_reopen_on_revert: false },
      status: "reverted",
    };
    expect(shouldReopenParent(reverted as any, []).reopen).toBe(false);
  });
});
