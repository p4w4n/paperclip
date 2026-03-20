import { describe, expect, it } from "vitest";
import { buildWorktreeMergePlan, parseWorktreeMergeScopes } from "../commands/worktree-merge-history-lib.js";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "hello",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

describe("worktree merge history planner", () => {
  it("parses default scopes", () => {
    expect(parseWorktreeMergeScopes(undefined)).toEqual(["issues", "comments"]);
    expect(parseWorktreeMergeScopes("issues")).toEqual(["issues"]);
  });

  it("dedupes nested worktree issues by preserved source uuid", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10", title: "Shared" });
    const branchOneIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-22",
      title: "Branch one issue",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const branchTwoIssue = makeIssue({
      id: "issue-c",
      identifier: "PAP-23",
      title: "Branch two issue",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 500,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, branchOneIssue, branchTwoIssue],
      targetIssues: [sharedIssue, branchOneIssue],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.issuesToInsert).toBe(1);
    expect(plan.issuePlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual(["issue-c"]);
    expect(plan.issuePlans.find((item) => item.source.id === "issue-c" && item.action === "insert")).toMatchObject({
      previewIdentifier: "PAP-501",
    });
  });

  it("clears missing references and coerces in_progress without an assignee", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-x",
          identifier: "PAP-99",
          status: "in_progress",
          assigneeAgentId: "agent-missing",
          projectId: "project-missing",
          projectWorkspaceId: "workspace-missing",
          goalId: "goal-missing",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetStatus).toBe("todo");
    expect(insert.targetAssigneeAgentId).toBeNull();
    expect(insert.targetProjectId).toBeNull();
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.targetGoalId).toBeNull();
    expect(insert.adjustments).toEqual([
      "clear_assignee_agent",
      "clear_project",
      "clear_project_workspace",
      "clear_goal",
      "coerce_in_progress_to_todo",
    ]);
  });

  it("applies an explicit project mapping override instead of clearing the project", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-project-map",
          identifier: "PAP-77",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [{ id: "target-project-1", name: "Mapped project", status: "in_progress" }] as any,
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      projectIdOverrides: {
        "source-project-1": "target-project-1",
      },
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetProjectId).toBe("target-project-1");
    expect(insert.projectResolution).toBe("mapped");
    expect(insert.mappedProjectName).toBe("Mapped project");
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.adjustments).toEqual(["clear_project_workspace"]);
  });

  it("imports comments onto shared or newly imported issues while skipping existing comments", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const newIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-11",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const existingComment = makeComment({ id: "comment-existing", issueId: "issue-a" });
    const sharedIssueComment = makeComment({ id: "comment-shared", issueId: "issue-a" });
    const newIssueComment = makeComment({
      id: "comment-new-issue",
      issueId: "issue-b",
      authorAgentId: "missing-agent",
      createdAt: new Date("2026-03-20T01:05:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, newIssue],
      targetIssues: [sharedIssue],
      sourceComments: [existingComment, sharedIssueComment, newIssueComment],
      targetComments: [existingComment],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.commentsToInsert).toBe(2);
    expect(plan.counts.commentsExisting).toBe(1);
    expect(plan.commentPlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual([
      "comment-shared",
      "comment-new-issue",
    ]);
    expect(plan.adjustments.clear_author_agent).toBe(1);
  });
});
