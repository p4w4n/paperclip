// Plan 4 e2e: dispatch-or-local + workspace-lease-store + a real
// in-process worker client + RunDispatcher. Pins the contract that
// two concurrent execute() calls on the same filestore-mode
// workspace serialize: the first acquires the lease and dispatches,
// the second rejects with WorkspaceBusyError, and after the first
// completes the second can re-acquire.
//
// Uses an embedded postgres for the lease store; the gRPC stack runs
// on a loopback port like the existing distributed/end-to-end test.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  projects,
  projectWorkspaces,
  workspaceLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import { startWorkerGrpcServer, stopWorkerGrpcServer } from "../../worker-rpc/server.js";
import { sharedSecretAuthStrategy } from "../../worker-rpc/auth.js";
import { WorkerRegistry } from "../../services/worker-registry.js";
import { RunDispatcher } from "../../services/run-dispatcher.js";
import { createWorkspaceLeaseStore } from "../../services/workspace-lease-store.js";
import {
  createDispatchOrLocal,
  WorkspaceBusyError,
} from "../../adapters/dispatch-or-local.js";
import {
  awaitRunCompletion,
} from "../../adapters/run-completion-registry.js";
import { startWorkerClient, type WorkerClientHandle } from "@paperclipai/worker/client";
import { staticBearerAuth } from "@paperclipai/worker/auth-client";
import { handleRunDispatch } from "@paperclipai/worker/run-handler";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("distributed filestore-mode e2e", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let port = 0;
  let registry!: WorkerRegistry;
  let dispatcher!: RunDispatcher;
  let client: WorkerClientHandle | null = null;

  // Hand-rolled, controlled adapter so we can hold a run "in flight"
  // while the second execute() races. Never auto-completes; the test
  // calls release() to let the first run finish.
  let resolveAdapter: (() => void) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fs-e2e-");
    db = createDb(tempDb.connectionString);
    registry = new WorkerRegistry();
    dispatcher = new RunDispatcher(registry);
    port = await startWorkerGrpcServer({
      auth: sharedSecretAuthStrategy({ secret: "fs-e2e" }),
      registry,
      dispatcher,
      bindAddress: "127.0.0.1:0",
    });

    // Connect ONE worker; both dispatches use the same client.
    client = await startWorkerClient({
      controlPlaneAddress: `127.0.0.1:${port}`,
      auth: staticBearerAuth("fs-e2e"),
      workerId: "w-fs",
      instanceId: "i-fs",
      adapters: ["claude_local"],
      maxConcurrent: 1,
      version: "0.0.0",
      onDispatch: (msg) => {
        if (msg.payload.case !== "runDispatch") return;
        void handleRunDispatch(msg.payload.value, {
          realizeWorkspace: async () => ({ cwd: "/tmp", cleanup: async () => {} }),
          runAdapter: async () => {
            // Block until the test releases — lets us drive the
            // "second execute while first is in flight" case.
            await new Promise<void>((r) => {
              resolveAdapter = r;
            });
            return { exitCode: 0, signal: null, summary: "ok" };
          },
          fetchSecrets: async () => ({}),
          send: (m) => client!.send(m),
        });
      },
    });

    // Wait for worker registration before any dispatch.
    for (let i = 0; i < 50; i++) {
      if (registry.list().some((w) => w.workerId === "w-fs")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(workspaceLeases);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await client?.stop();
    await stopWorkerGrpcServer();
    await tempDb?.cleanup();
  });

  async function makeFilestoreWorkspace(): Promise<string> {
    const company = await db
      .insert(companies)
      .values({ name: `c-${randomUUID()}`, issuePrefix: `FS${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((r) => r[0]!);
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "p" })
      .returning()
      .then((r) => r[0]!);
    const ws = await db
      .insert(projectWorkspaces)
      .values({ companyId: company.id, projectId: project.id, name: "ws", filestoreMode: "on" })
      .returning()
      .then((r) => r[0]!);
    return ws.id;
  }

  it("serializes two concurrent execute() calls on the same workspace via the lease", async () => {
    const wsId = await makeFilestoreWorkspace();
    const leaseStore = createWorkspaceLeaseStore(db);

    function makeAdapter() {
      return createDispatchOrLocal({
        adapterType: "claude_local",
        // Should never be called; filestore mode throws on dispatch
        // failure rather than falling back to local.
        localExecute: async () => {
          throw new Error("local fallback should not run in filestore mode");
        },
        dispatcher: { tryDispatch: dispatcher.tryDispatch.bind(dispatcher), markCompleted: dispatcher.markCompleted.bind(dispatcher) },
        registry: { pickFor: registry.pickFor.bind(registry) },
        awaitCompletion: (runId) => awaitRunCompletion(runId),
        acquireWorkspaceLease: async ({ runId, leaseSeconds }) =>
          leaseStore.acquire({
            projectWorkspaceId: wsId,
            runId: null, // would use real heartbeat_runs id in production; null for the test
            workerId: "ctrl-plane",
            leaseSeconds,
          }).then((r) => {
            void runId;
            return r;
          }),
        releaseWorkspaceLease: ({ leaseId }) => leaseStore.release({ leaseId }),
        leaseSeconds: 30,
      });
    }

    const ctxA: AdapterExecutionContext = {
      runId: randomUUID(),
      agent: { id: randomUUID() },
      config: {},
      context: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const ctxB: AdapterExecutionContext = {
      runId: randomUUID(),
      agent: { id: randomUUID() },
      config: {},
      context: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Start run A — adapter blocks; lease acquired, dispatch sent.
    const runA = makeAdapter().execute(ctxA) as Promise<AdapterExecutionResult>;
    // Wait briefly for the worker to receive the dispatch and arm the
    // adapter blocker. Without this, run B might race past the lease
    // check before run A's await has landed.
    for (let i = 0; i < 100; i++) {
      if (resolveAdapter !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Run B against the same workspace → busy.
    await expect(makeAdapter().execute(ctxB)).rejects.toBeInstanceOf(WorkspaceBusyError);

    // Release run A's adapter; A completes; lease released.
    resolveAdapter?.();
    resolveAdapter = null;
    const resultA = await runA;
    expect(resultA.summary).toBe("ok");

    // Run B can now acquire and dispatch successfully.
    const runB = makeAdapter().execute(ctxB) as Promise<AdapterExecutionResult>;
    for (let i = 0; i < 100; i++) {
      if (resolveAdapter !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    resolveAdapter?.();
    resolveAdapter = null;
    const resultB = await runB;
    expect(resultB.summary).toBe("ok");
  }, 30_000);
});
