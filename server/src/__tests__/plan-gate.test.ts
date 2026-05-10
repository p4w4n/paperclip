import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeRequiredError } from "../services/outcomes/types.js";

// ── mock the gate-check predicate ──────────────────────────────────────────
const mockAllOutcomesVerified = vi.hoisted(() => vi.fn(async () => true as true));
const mockMaterializeContract = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: 0, kept: 0, pendingDeleted: 0, droppedVerified: 0 })),
);

vi.mock("../services/outcomes/predicate.js", () => ({
  allOutcomesVerified: mockAllOutcomesVerified,
}));

vi.mock("../services/outcomes/service.js", () => ({
  getOutcomesService: () => ({
    materializeContract: mockMaterializeContract,
  }),
}));

// ── mock the plan service singleton ───────────────────────────────────────
const mockCompletePhase = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/plans/service.js", () => ({
  getPlanService: () => ({
    createPlan: vi.fn(),
    revisePlan: vi.fn(),
    submitReview: vi.fn(),
    startPhase: vi.fn(async () => undefined),
    completePhase: mockCompletePhase,
    recordDecision: vi.fn(),
    forget: vi.fn(),
  }),
}));

// ── mock company / issue service layer ────────────────────────────────────
vi.mock("../services/index.js", () => ({
  issueService: () => ({
    getById: vi.fn(async () => null),
    getByIdentifier: vi.fn(async () => null),
  }),
}));

/** Build a minimal express app wired to the real plans routes */
async function createApp() {
  const [{ plansRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/plans.js")>("../routes/plans.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  // Minimal fake db: peekPlan resolves to company-1, and plan row includes
  // requiredOutcomes so the gate can inspect it.
  const fakePlanRow = {
    id: "plan-1",
    companyId: "company-1",
    status: "in_progress",
    requiredOutcomes: [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }],
    currentRevisionId: null,
    currentRevisionNumber: 1,
    approvalPolicy: "one_human",
    phaseAdvancePolicy: "auto",
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: null,
    completedAt: null,
    title: "Test Plan",
    issueId: null,
  };

  const fakeDb = {
    select: () => fakeDb,
    from: () => fakeDb,
    where: () => fakeDb,
    orderBy: () => fakeDb,
    limit: () => Promise.resolve([fakePlanRow]),
    // make it also act as the select result when awaited directly
    then: (resolve: (v: any) => any) => Promise.resolve([fakePlanRow]).then(resolve),
  };

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
  app.use("/api", plansRoutes(fakeDb as any));
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("plan gate — required_outcomes blocks plan completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects completePhase with 422 when required outcomes have pending rows", async () => {
    const pendingOutcomeErr = new OutcomeRequiredError({
      target: { kind: "plan", id: "plan-1" },
      pending: [
        {
          id: "o1",
          kind: "artifact_declared",
          requiredMeta: { name: "patch" },
          status: "pending",
        },
      ],
    });

    // Gate returns an error (pending outcomes exist).
    mockAllOutcomesVerified.mockResolvedValue(pendingOutcomeErr);

    const res = await request(await createApp())
      .post("/api/plans/plan-1/phases/phase-1/complete")
      .send({ exitCriteriaMet: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("outcome_required");
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].kind).toBe("artifact_declared");
    // completePhase service should NOT have been called.
    expect(mockCompletePhase).not.toHaveBeenCalled();
  });

  it("allows completePhase after all outcomes are verified", async () => {
    // Gate returns true — all outcomes verified.
    mockAllOutcomesVerified.mockResolvedValue(true);
    mockCompletePhase.mockResolvedValue(undefined);

    const res = await request(await createApp())
      .post("/api/plans/plan-1/phases/phase-1/complete")
      .send({ exitCriteriaMet: true });

    expect(res.status).toBe(200);
    expect(mockCompletePhase).toHaveBeenCalled();
  });

  it("calls materializeContract when requiredOutcomes is provided in PATCH /plans/:id", async () => {
    const requiredOutcomes = [
      { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
    ];

    const res = await request(await createApp())
      .patch("/api/plans/plan-1")
      .send({ requiredOutcomes });

    expect(res.status).toBe(200);
    expect(mockMaterializeContract).toHaveBeenCalledWith(
      { kind: "plan", id: "plan-1", companyId: "company-1" },
      requiredOutcomes,
    );
  });
});
