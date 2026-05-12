import { describe, expect, it } from "vitest";
import { mergeSuggestedOutcomes } from "../apply-suggested-outcomes.js";

describe("mergeSuggestedOutcomes", () => {
  const existing = [
    { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
  ];
  const suggested = [
    { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }, // dup
    { kind: "approval_granted",  requiredMeta: { name: "risk", approval_kind: "risk" } },         // new
  ];

  it("skip_existing keeps existing entries; appends only new (kind, name)", () => {
    const r = mergeSuggestedOutcomes(existing, suggested, "skip_existing");
    expect(r.merged).toHaveLength(3);
    expect(r.added).toEqual([{ kind: "approval_granted", name: "risk" }]);
    expect(r.skippedExisting).toEqual([{ kind: "artifact_declared", name: "patch" }]);
  });

  it("replace drops existing and uses suggested verbatim; partitions added vs replacedExisting", () => {
    const r = mergeSuggestedOutcomes(existing, suggested, "replace");
    expect(r.merged).toEqual(suggested);
    // "artifact_declared/patch" already existed — not net-new
    expect(r.added).toEqual([{ kind: "approval_granted", name: "risk" }]);
    // "artifact_declared/patch" was pre-existing (replacedExisting, back-compat field)
    expect(r.skippedExisting).toEqual([{ kind: "artifact_declared", name: "patch" }]);
  });

  it("replace strategy with an overlap reports `added` only for net-new entries", () => {
    const existingEntries = [
      { kind: "manual_signoff", requiredMeta: { name: "ack" } },
      { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
    ];
    const suggestedEntries = [
      { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }, // already exists
      { kind: "approval_granted",  requiredMeta: { name: "risk", approval_kind: "risk" } },         // truly new
    ];
    const r = mergeSuggestedOutcomes(existingEntries, suggestedEntries, "replace");
    expect(r.merged).toEqual(suggestedEntries);
    expect(r.added).toEqual([{ kind: "approval_granted", name: "risk" }]);
    expect(r.skippedExisting).toEqual([{ kind: "artifact_declared", name: "patch" }]);
  });

  it("empty suggested with skip_existing is a no-op", () => {
    const r = mergeSuggestedOutcomes(existing, [], "skip_existing");
    expect(r.merged).toEqual(existing);
    expect(r.added).toEqual([]);
  });
});
