import { describe, expect, it } from "vitest";
import { matchPlaybookApplicability } from "../applicability.js";
import type { IssueContext, Playbook } from "../types.js";

const ctxBase: IssueContext = {
  title: "Deploy to staging failed",
  labels: ["deploy", "staging"],
  projectId: "proj-1",
};

const pbBase: Playbook = {
  id: "pb-1",
  companyId: "co-1",
  agentId: null,
  title: "Staging deploy recovery",
  slug: "staging-deploy-recovery",
  status: "active",
  currentRevisionId: null,
  currentRevisionNumber: 1,
  applicabilityConditions: null,
  sourceRunIds: null,
  sourcePlanIds: null,
  confidence: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  approvedAt: null,
  archivedAt: null,
};

describe("matchPlaybookApplicability", () => {
  it("returns 0 with no conditions", () => {
    expect(matchPlaybookApplicability(ctxBase, pbBase).score).toBe(0);
  });

  it("scores keyword hits", () => {
    const out = matchPlaybookApplicability(ctxBase, {
      ...pbBase,
      applicabilityConditions: { issue_keywords: ["deploy", "staging"] },
    });
    expect(out.score).toBeCloseTo(0.4, 5); // 2 keywords * 0.2
  });

  it("scores label hits", () => {
    const out = matchPlaybookApplicability(ctxBase, {
      ...pbBase,
      applicabilityConditions: { labels: ["deploy"] },
    });
    expect(out.score).toBeCloseTo(0.3, 5);
  });

  it("scores project match", () => {
    const out = matchPlaybookApplicability(ctxBase, {
      ...pbBase,
      applicabilityConditions: { project_id: "proj-1" },
    });
    expect(out.score).toBeCloseTo(0.5, 5);
  });

  it("scores agent match", () => {
    const out = matchPlaybookApplicability(
      { ...ctxBase, assigneeAgentId: "ag-1" },
      { ...pbBase, agentId: "ag-1" },
    );
    expect(out.score).toBeCloseTo(0.4, 5);
  });

  it("multiplies by confidence", () => {
    const out = matchPlaybookApplicability(ctxBase, {
      ...pbBase,
      applicabilityConditions: { issue_keywords: ["deploy", "staging"] },
      confidence: 0.5,
    });
    expect(out.score).toBeCloseTo(0.2, 5); // 0.4 * 0.5
  });

  it("clamps to 1", () => {
    const out = matchPlaybookApplicability(
      { ...ctxBase, assigneeAgentId: "ag-1" },
      {
        ...pbBase,
        agentId: "ag-1",
        applicabilityConditions: {
          issue_keywords: ["deploy", "staging", "failed"],
          labels: ["deploy", "staging"],
          project_id: "proj-1",
        },
      },
    );
    expect(out.score).toBeLessThanOrEqual(1);
  });

  it("includes a human-readable reason", () => {
    const out = matchPlaybookApplicability(ctxBase, {
      ...pbBase,
      applicabilityConditions: {
        issue_keywords: ["deploy"],
        labels: ["staging"],
      },
    });
    expect(out.reason).toContain("keywords");
    expect(out.reason).toContain("labels");
  });
});
