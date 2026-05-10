// Test: routine → issue creation copies defaultRequiredOutcomes and materializes contract.
//
// Uses embedded Postgres (same pattern as routines-service.test.ts) so the full
// dispatchRoutineRun path runs against a real DB.  OutcomesService is mocked so
// the test doesn't need OUTCOME_KINDS validation fixtures.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  outcomes,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const mockMaterializeContract = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: 1, kept: 0, pendingDeleted: 0, droppedVerified: 0 })),
);

vi.mock("../services/outcomes/service.js", () => ({
  getOutcomesService: () => ({
    materializeContract: mockMaterializeContract,
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine contract inheritance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine outcome inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-contract-inheritance-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    mockMaterializeContract.mockClear();
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(outcomes);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "ContractCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Automator",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Outcomes project",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (_agentId, wakeupOpts) => {
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: _agentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });

    return { companyId, agentId, projectId, svc };
  }

  it("copies default_required_outcomes onto new issues created from a routine", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    const defaultRequiredOutcomes = [
      { kind: "manual_signoff", requiredMeta: { name: "ack" } },
    ];

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Contract routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        defaultRequiredOutcomes,
      },
      {},
    );

    // Verify the routine stored the contract
    expect(routine.defaultRequiredOutcomes).toEqual(defaultRequiredOutcomes);

    // Dispatch the routine to create an issue
    const run = await svc.runRoutine(routine.id, {
      source: "manual",
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    // Check the created issue has requiredOutcomes set
    const [issueRow] = await db
      .select({ requiredOutcomes: issues.requiredOutcomes })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));

    expect(issueRow).toBeDefined();
    expect(issueRow!.requiredOutcomes).toEqual(defaultRequiredOutcomes);

    // Check that materializeContract was called with the correct arguments
    expect(mockMaterializeContract).toHaveBeenCalledOnce();
    expect(mockMaterializeContract).toHaveBeenCalledWith(
      { kind: "issue", id: run.linkedIssueId, companyId },
      defaultRequiredOutcomes,
    );
  }, 30_000);

  it("does not call materializeContract when defaultRequiredOutcomes is empty", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "No-contract routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        defaultRequiredOutcomes: [],
      },
      {},
    );

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(mockMaterializeContract).not.toHaveBeenCalled();
  }, 30_000);
});
