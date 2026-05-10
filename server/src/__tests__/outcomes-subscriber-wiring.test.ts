import { describe, expect, it } from "vitest";
import { artifactsEvents } from "../services/artifacts/events.js";
import { plansEvents } from "../services/plans/events.js";
import { approvalsEvents } from "../services/approvals-events.js";

describe("substrate event emitters", () => {
  it("artifactsEvents emits 'declared'", () => {
    let payload: any = null;
    artifactsEvents.on("declared", (p) => { payload = p; });
    artifactsEvents.emit("declared", {
      id: "a1", companyId: "c1", issueId: "i1",
      kind: "code.patch", name: "patch", blobSha256: "deadbeef", declaredAt: new Date(),
    });
    expect(payload?.id).toBe("a1");
  });

  it("plansEvents emits the four event names", () => {
    const seen = new Set<string>();
    plansEvents.on("completed", () => seen.add("completed"));
    plansEvents.on("phaseCompleted", () => seen.add("phaseCompleted"));
    plansEvents.on("phaseMarkdownUpdated", () => seen.add("phaseMarkdownUpdated"));
    plansEvents.on("decisionRecorded", () => seen.add("decisionRecorded"));
    plansEvents.emit("completed", { planId: "p1", companyId: "c1", issueId: null, completedAt: new Date(), revisionId: null });
    plansEvents.emit("phaseCompleted", { planPhaseId: "ph1", companyId: "c1", planId: "p1", planIssueId: null, exitCriteriaMarkdown: "" });
    plansEvents.emit("phaseMarkdownUpdated", { planPhaseId: "ph1", companyId: "c1", planId: "p1", planIssueId: null, exitCriteriaMarkdown: "" });
    plansEvents.emit("decisionRecorded", { decisionId: "d1", companyId: "c1", planId: "p1", planIssueId: null, title: "go", chosenOptionId: "yes", decidedAt: new Date() });
    expect(seen).toEqual(new Set(["completed", "phaseCompleted", "phaseMarkdownUpdated", "decisionRecorded"]));
  });

  it("approvalsEvents emits 'approved'", () => {
    let payload: any = null;
    approvalsEvents.on("approved", (p) => { payload = p; });
    approvalsEvents.emit("approved", {
      approvalId: "ap1", companyId: "c1", approvalKind: "legal",
      decidedByUserId: "u1", decidedAt: new Date(),
    });
    expect(payload?.approvalId).toBe("ap1");
  });
});
