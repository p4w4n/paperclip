import { describe, expect, it } from "vitest";
import { buildArtifactsSummarySection } from "../run-summary.js";

describe("buildArtifactsSummarySection", () => {
  it("returns null when there are no artifacts", () => {
    expect(buildArtifactsSummarySection([])).toBeNull();
  });

  it("renders a markdown bullet per artifact", () => {
    const out = buildArtifactsSummarySection([
      { id: "a-1", kind: "code.file", name: "src/foo.ts", previewUrl: null },
      { id: "a-2", kind: "doc.markdown", name: "report", previewUrl: "/preview/a-2/" },
    ]);
    expect(out).toContain("## Work products");
    expect(out).toContain("**code.file** `src/foo.ts`");
    expect(out).toContain("**doc.markdown** `report`");
  });

  it("includes preview link when present", () => {
    const out = buildArtifactsSummarySection([
      { id: "a-2", kind: "chart", name: "perf", previewUrl: "/preview/a-2/" },
    ]);
    expect(out).toContain("[preview](/preview/a-2/)");
  });
});
