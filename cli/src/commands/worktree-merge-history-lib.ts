import {
  agents,
  goals,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";

type IssueRow = typeof issues.$inferSelect;
type CommentRow = typeof issueComments.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type GoalRow = typeof goals.$inferSelect;

export const WORKTREE_MERGE_SCOPES = ["issues", "comments"] as const;
export type WorktreeMergeScope = (typeof WORKTREE_MERGE_SCOPES)[number];

export type ImportAdjustment =
  | "clear_assignee_agent"
  | "clear_project"
  | "clear_project_workspace"
  | "clear_goal"
  | "clear_author_agent"
  | "coerce_in_progress_to_todo";

export type IssueMergeAction = "skip_existing" | "insert";
export type CommentMergeAction = "skip_existing" | "skip_missing_parent" | "insert";

export type PlannedIssueInsert = {
  source: IssueRow;
  action: "insert";
  previewIssueNumber: number;
  previewIdentifier: string;
  targetStatus: string;
  targetAssigneeAgentId: string | null;
  targetCreatedByAgentId: string | null;
  targetProjectId: string | null;
  targetProjectWorkspaceId: string | null;
  targetGoalId: string | null;
  projectResolution: "preserved" | "cleared" | "mapped";
  mappedProjectName: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedIssueSkip = {
  source: IssueRow;
  action: "skip_existing";
  driftKeys: string[];
};

export type PlannedCommentInsert = {
  source: CommentRow;
  action: "insert";
  targetAuthorAgentId: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedCommentSkip = {
  source: CommentRow;
  action: "skip_existing" | "skip_missing_parent";
};

export type WorktreeMergePlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  previewIssueCounterStart: number;
  scopes: WorktreeMergeScope[];
  issuePlans: Array<PlannedIssueInsert | PlannedIssueSkip>;
  commentPlans: Array<PlannedCommentInsert | PlannedCommentSkip>;
  counts: {
    issuesToInsert: number;
    issuesExisting: number;
    issueDrift: number;
    commentsToInsert: number;
    commentsExisting: number;
    commentsMissingParent: number;
  };
  adjustments: Record<ImportAdjustment, number>;
};

function compareIssueCoreFields(source: IssueRow, target: IssueRow): string[] {
  const driftKeys: string[] = [];
  if (source.title !== target.title) driftKeys.push("title");
  if ((source.description ?? null) !== (target.description ?? null)) driftKeys.push("description");
  if (source.status !== target.status) driftKeys.push("status");
  if (source.priority !== target.priority) driftKeys.push("priority");
  if ((source.parentId ?? null) !== (target.parentId ?? null)) driftKeys.push("parentId");
  if ((source.projectId ?? null) !== (target.projectId ?? null)) driftKeys.push("projectId");
  if ((source.projectWorkspaceId ?? null) !== (target.projectWorkspaceId ?? null)) driftKeys.push("projectWorkspaceId");
  if ((source.goalId ?? null) !== (target.goalId ?? null)) driftKeys.push("goalId");
  if ((source.assigneeAgentId ?? null) !== (target.assigneeAgentId ?? null)) driftKeys.push("assigneeAgentId");
  if ((source.assigneeUserId ?? null) !== (target.assigneeUserId ?? null)) driftKeys.push("assigneeUserId");
  return driftKeys;
}

function incrementAdjustment(
  counts: Record<ImportAdjustment, number>,
  adjustment: ImportAdjustment,
): void {
  counts[adjustment] += 1;
}

function sortIssuesForImport(sourceIssues: IssueRow[]): IssueRow[] {
  const byId = new Map(sourceIssues.map((issue) => [issue.id, issue]));
  const memoDepth = new Map<string, number>();

  const depthFor = (issue: IssueRow, stack = new Set<string>()): number => {
    const memoized = memoDepth.get(issue.id);
    if (memoized !== undefined) return memoized;
    if (!issue.parentId) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    if (stack.has(issue.id)) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    const parent = byId.get(issue.parentId);
    if (!parent) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    stack.add(issue.id);
    const depth = depthFor(parent, stack) + 1;
    stack.delete(issue.id);
    memoDepth.set(issue.id, depth);
    return depth;
  };

  return [...sourceIssues].sort((left, right) => {
    const depthDelta = depthFor(left) - depthFor(right);
    if (depthDelta !== 0) return depthDelta;
    const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
}

export function parseWorktreeMergeScopes(rawValue: string | undefined): WorktreeMergeScope[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return ["issues", "comments"];
  }

  const parsed = rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is WorktreeMergeScope =>
      (WORKTREE_MERGE_SCOPES as readonly string[]).includes(value),
    );

  if (parsed.length === 0) {
    throw new Error(
      `Invalid scope "${rawValue}". Expected a comma-separated list of: ${WORKTREE_MERGE_SCOPES.join(", ")}.`,
    );
  }

  return [...new Set(parsed)];
}

export function buildWorktreeMergePlan(input: {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  previewIssueCounterStart: number;
  scopes: WorktreeMergeScope[];
  sourceIssues: IssueRow[];
  targetIssues: IssueRow[];
  sourceComments: CommentRow[];
  targetComments: CommentRow[];
  targetAgents: AgentRow[];
  targetProjects: ProjectRow[];
  targetProjectWorkspaces: ProjectWorkspaceRow[];
  targetGoals: GoalRow[];
  projectIdOverrides?: Record<string, string | null | undefined>;
}): WorktreeMergePlan {
  const targetIssuesById = new Map(input.targetIssues.map((issue) => [issue.id, issue]));
  const targetCommentIds = new Set(input.targetComments.map((comment) => comment.id));
  const targetAgentIds = new Set(input.targetAgents.map((agent) => agent.id));
  const targetProjectIds = new Set(input.targetProjects.map((project) => project.id));
  const targetProjectsById = new Map(input.targetProjects.map((project) => [project.id, project]));
  const targetProjectWorkspaceIds = new Set(input.targetProjectWorkspaces.map((workspace) => workspace.id));
  const targetGoalIds = new Set(input.targetGoals.map((goal) => goal.id));
  const scopes = new Set(input.scopes);

  const adjustmentCounts: Record<ImportAdjustment, number> = {
    clear_assignee_agent: 0,
    clear_project: 0,
    clear_project_workspace: 0,
    clear_goal: 0,
    clear_author_agent: 0,
    coerce_in_progress_to_todo: 0,
  };

  const issuePlans: Array<PlannedIssueInsert | PlannedIssueSkip> = [];
  let nextPreviewIssueNumber = input.previewIssueCounterStart;
  for (const issue of sortIssuesForImport(input.sourceIssues)) {
    const existing = targetIssuesById.get(issue.id);
    if (existing) {
      issuePlans.push({
        source: issue,
        action: "skip_existing",
        driftKeys: compareIssueCoreFields(issue, existing),
      });
      continue;
    }

    nextPreviewIssueNumber += 1;
    const adjustments: ImportAdjustment[] = [];
    const targetAssigneeAgentId =
      issue.assigneeAgentId && targetAgentIds.has(issue.assigneeAgentId) ? issue.assigneeAgentId : null;
    if (issue.assigneeAgentId && !targetAssigneeAgentId) {
      adjustments.push("clear_assignee_agent");
      incrementAdjustment(adjustmentCounts, "clear_assignee_agent");
    }

    const targetCreatedByAgentId =
      issue.createdByAgentId && targetAgentIds.has(issue.createdByAgentId) ? issue.createdByAgentId : null;

    let targetProjectId =
      issue.projectId && targetProjectIds.has(issue.projectId) ? issue.projectId : null;
    let projectResolution: PlannedIssueInsert["projectResolution"] = targetProjectId ? "preserved" : "cleared";
    let mappedProjectName: string | null = null;
    const overrideProjectId =
      issue.projectId && input.projectIdOverrides
        ? input.projectIdOverrides[issue.projectId] ?? null
        : null;
    if (!targetProjectId && overrideProjectId && targetProjectIds.has(overrideProjectId)) {
      targetProjectId = overrideProjectId;
      projectResolution = "mapped";
      mappedProjectName = targetProjectsById.get(overrideProjectId)?.name ?? null;
    }
    if (issue.projectId && !targetProjectId) {
      adjustments.push("clear_project");
      incrementAdjustment(adjustmentCounts, "clear_project");
    }

    const targetProjectWorkspaceId =
      targetProjectId
      && targetProjectId === issue.projectId
      && issue.projectWorkspaceId
      && targetProjectWorkspaceIds.has(issue.projectWorkspaceId)
        ? issue.projectWorkspaceId
        : null;
    if (issue.projectWorkspaceId && !targetProjectWorkspaceId) {
      adjustments.push("clear_project_workspace");
      incrementAdjustment(adjustmentCounts, "clear_project_workspace");
    }

    const targetGoalId =
      issue.goalId && targetGoalIds.has(issue.goalId) ? issue.goalId : null;
    if (issue.goalId && !targetGoalId) {
      adjustments.push("clear_goal");
      incrementAdjustment(adjustmentCounts, "clear_goal");
    }

    let targetStatus = issue.status;
    if (
      targetStatus === "in_progress"
      && !targetAssigneeAgentId
      && !(issue.assigneeUserId && issue.assigneeUserId.trim().length > 0)
    ) {
      targetStatus = "todo";
      adjustments.push("coerce_in_progress_to_todo");
      incrementAdjustment(adjustmentCounts, "coerce_in_progress_to_todo");
    }

    issuePlans.push({
      source: issue,
      action: "insert",
      previewIssueNumber: nextPreviewIssueNumber,
      previewIdentifier: `${input.issuePrefix}-${nextPreviewIssueNumber}`,
      targetStatus,
      targetAssigneeAgentId,
      targetCreatedByAgentId,
      targetProjectId,
      targetProjectWorkspaceId,
      targetGoalId,
      projectResolution,
      mappedProjectName,
      adjustments,
    });
  }

  const issueIdsAvailableAfterImport = new Set<string>([
    ...input.targetIssues.map((issue) => issue.id),
    ...issuePlans.filter((plan): plan is PlannedIssueInsert => plan.action === "insert").map((plan) => plan.source.id),
  ]);

  const commentPlans: Array<PlannedCommentInsert | PlannedCommentSkip> = [];
  if (scopes.has("comments")) {
    const sortedComments = [...input.sourceComments].sort((left, right) => {
      const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
      if (createdDelta !== 0) return createdDelta;
      return left.id.localeCompare(right.id);
    });

    for (const comment of sortedComments) {
      if (targetCommentIds.has(comment.id)) {
        commentPlans.push({ source: comment, action: "skip_existing" });
        continue;
      }
      if (!issueIdsAvailableAfterImport.has(comment.issueId)) {
        commentPlans.push({ source: comment, action: "skip_missing_parent" });
        continue;
      }

      const adjustments: ImportAdjustment[] = [];
      const targetAuthorAgentId =
        comment.authorAgentId && targetAgentIds.has(comment.authorAgentId) ? comment.authorAgentId : null;
      if (comment.authorAgentId && !targetAuthorAgentId) {
        adjustments.push("clear_author_agent");
        incrementAdjustment(adjustmentCounts, "clear_author_agent");
      }

      commentPlans.push({
        source: comment,
        action: "insert",
        targetAuthorAgentId,
        adjustments,
      });
    }
  }

  const counts = {
    issuesToInsert: issuePlans.filter((plan) => plan.action === "insert").length,
    issuesExisting: issuePlans.filter((plan) => plan.action === "skip_existing").length,
    issueDrift: issuePlans.filter((plan) => plan.action === "skip_existing" && plan.driftKeys.length > 0).length,
    commentsToInsert: commentPlans.filter((plan) => plan.action === "insert").length,
    commentsExisting: commentPlans.filter((plan) => plan.action === "skip_existing").length,
    commentsMissingParent: commentPlans.filter((plan) => plan.action === "skip_missing_parent").length,
  };

  return {
    companyId: input.companyId,
    companyName: input.companyName,
    issuePrefix: input.issuePrefix,
    previewIssueCounterStart: input.previewIssueCounterStart,
    scopes: input.scopes,
    issuePlans,
    commentPlans,
    counts,
    adjustments: adjustmentCounts,
  };
}
