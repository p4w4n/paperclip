import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeRequiredError } from "../services/outcomes/types.js";

const mockAllOutcomesVerified = vi.hoisted(() => vi.fn(async () => true as true));
const mockMaterializeContract = vi.hoisted(() => vi.fn(async () => ({ inserted: 0, kept: 0, pendingDeleted: 0, droppedVerified: 0 })));

vi.mock("../services/outcomes/predicate.js", () => ({
  allOutcomesVerified: mockAllOutcomesVerified,
}));

vi.mock("../services/outcomes/service.js", () => ({
  getOutcomesService: () => ({
    materializeContract: mockMaterializeContract,
  }),
  // initializeOutcomesService and OutcomeRequiredError re-export not needed here
}));

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => null),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({})),
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
    listCompanyIds: vi.fn(async () => []),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

/** Minimal issue shape with required_outcomes populated */
function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    title: "Gate test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    executionPolicy: null,
    executionState: null,
    goalId: null,
    projectId: null,
    projectWorkspaceId: null,
    requiredOutcomes: [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }],
    labels: [],
    labelIds: [],
    blockedByIssueIds: [],
    ...overrides,
  };
}

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue gate — required_outcomes blocks status=done", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("rejects status=done with 422 when required outcomes have pending rows", async () => {
    const pendingOutcomeErr = new OutcomeRequiredError({
      target: { kind: "issue", id: "issue-1" },
      pending: [{ id: "o1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" }],
    });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    // Gate check returns an OutcomeRequiredError (pending outcomes exist).
    mockAllOutcomesVerified.mockResolvedValue(pendingOutcomeErr);

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("outcome_required");
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].kind).toBe("artifact_declared");
    // Ensure svc.update was NOT called (issue was not updated).
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows status=done after all outcomes are verified", async () => {
    const issueData = makeIssue({ requiredOutcomes: [{ kind: "artifact_declared", requiredMeta: { name: "patch" } }] });
    mockIssueService.getById.mockResolvedValue(issueData);
    // Gate check returns true — all outcomes verified.
    mockAllOutcomesVerified.mockResolvedValue(true);
    mockIssueService.update.mockResolvedValue({ ...issueData, status: "done" });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("skips gate check when issue has no required_outcomes", async () => {
    const issueData = makeIssue({ requiredOutcomes: [] });
    mockIssueService.getById.mockResolvedValue(issueData);
    mockIssueService.update.mockResolvedValue({ ...issueData, status: "done" });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    // allOutcomesVerified should not have been called when there are no required outcomes.
    expect(mockAllOutcomesVerified).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("calls materializeContract when requiredOutcomes is provided in the body", async () => {
    const issueData = makeIssue({ requiredOutcomes: [] });
    mockIssueService.getById.mockResolvedValue(issueData);
    mockIssueService.update.mockResolvedValue({ ...issueData });

    const requiredOutcomes = [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }];

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ requiredOutcomes });

    expect(res.status).toBe(200);
    expect(mockMaterializeContract).toHaveBeenCalledWith(
      { kind: "issue", id: "issue-1", companyId: "company-1" },
      requiredOutcomes,
    );
  });
});
