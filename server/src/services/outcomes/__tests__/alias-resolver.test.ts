import { describe, expect, it } from "vitest";
import { isSlotSatisfied, expandContractEntryToRows, baseNameOf, groupBySlot } from "../alias-resolver.js";

describe("isSlotSatisfied", () => {
  it("returns true when the primary row is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" }, status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(true);
  });

  it("returns true when only an alternative is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },         status: "pending"  },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },   status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(true);
  });

  it("returns false when no row in the slot is verified", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },         status: "pending"  },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },   status: "pending"  },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });

  it("reverted rows do not satisfy a slot", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" }, status: "reverted" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });

  it("a verified row in a DIFFERENT slot does not satisfy", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "other" }, status: "verified" },
    ];
    expect(isSlotSatisfied(rows as any, "ci")).toBe(false);
  });
});

describe("baseNameOf", () => {
  it("strips :alt:N suffix", () => {
    expect(baseNameOf("ci")).toBe("ci");
    expect(baseNameOf("ci:alt:0")).toBe("ci");
    expect(baseNameOf("ci:alt:7")).toBe("ci");
  });

  it("handles names that themselves contain :alt:", () => {
    expect(baseNameOf("ops:alt:standin")).toBe("ops:alt:standin");
    expect(baseNameOf("ops:alt:standin:alt:0")).toBe("ops:alt:standin");
  });
});

describe("groupBySlot", () => {
  it("groups rows by slot base name", () => {
    const rows = [
      { kind: "external_signal", requiredMeta: { name: "ci" },        status: "pending" },
      { kind: "manual_signoff",  requiredMeta: { name: "ci:alt:0" },  status: "pending" },
      { kind: "manual_signoff",  requiredMeta: { name: "ack" },       status: "pending" },
    ];
    const groups = groupBySlot(rows as any);
    expect(Object.keys(groups).sort()).toEqual(["ack", "ci"]);
    expect(groups.ci).toHaveLength(2);
    expect(groups.ack).toHaveLength(1);
  });
});

describe("expandContractEntryToRows", () => {
  it("returns a single row when no alternatives", () => {
    const rows = expandContractEntryToRows({
      kind: "manual_signoff",
      requiredMeta: { name: "ack" },
    });
    expect(rows).toEqual([
      { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    ]);
  });

  it("expands N alternatives to N+1 rows with :alt:N suffix", () => {
    const rows = expandContractEntryToRows({
      kind: "external_signal",
      requiredMeta: { name: "ci", source: "x" },
      alternatives: [
        { kind: "manual_signoff", requiredMeta: { required_role: "ops" } },
        { kind: "approval_granted", requiredMeta: { approval_kind: "risk" } },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].requiredMeta.name).toBe("ci");
    expect(rows[1].requiredMeta.name).toBe("ci:alt:0");
    expect(rows[2].requiredMeta.name).toBe("ci:alt:1");
  });
});
