import { describe, expect, it } from "vitest";
import {
  currentRevision,
  nextRevisionNumber,
  revisionDiff,
  type RevisionLike,
} from "../revisions.js";

const rev = (n: number, content = ""): RevisionLike => ({
  id: `rev-${n}`,
  revisionNumber: n,
  contentMarkdown: content,
  parentRevisionId: n > 1 ? `rev-${n - 1}` : null,
  createdAt: new Date(),
});

describe("nextRevisionNumber", () => {
  it("returns 1 for empty", () => {
    expect(nextRevisionNumber([])).toBe(1);
  });
  it("returns max+1 across unordered input", () => {
    expect(nextRevisionNumber([rev(2), rev(1), rev(3)])).toBe(4);
  });
});

describe("currentRevision", () => {
  it("returns null for empty", () => {
    expect(currentRevision([])).toBeNull();
  });
  it("returns the highest-numbered revision", () => {
    const out = currentRevision([rev(2), rev(1), rev(3)]);
    expect(out?.revisionNumber).toBe(3);
  });
});

describe("revisionDiff", () => {
  it("treats null prev as empty", () => {
    expect(revisionDiff(null, "hello")).toContain("+ hello");
  });
  it("emits +/- for changed lines", () => {
    const out = revisionDiff("a\nb\nc", "a\nB\nc");
    expect(out).toContain("- b");
    expect(out).toContain("+ B");
  });
  it("preserves unchanged lines with two-space prefix", () => {
    const out = revisionDiff("a\nb", "a\nB");
    expect(out).toContain("  a");
  });
  it("handles add at end", () => {
    const out = revisionDiff("a", "a\nb");
    expect(out).toContain("+ b");
  });
});
