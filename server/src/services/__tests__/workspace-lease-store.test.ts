// Plan 4 lease-store tests run against a real embedded postgres because
// the partial unique index `WHERE released_at IS NULL` is the actual
// concurrency oracle — mocking the DB layer would just double-test the
// translation code without verifying the constraint enforces what we
// claim it does.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects, projectWorkspaces, workspaceLeases } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createWorkspaceLeaseStore } from "../workspace-lease-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workspace lease store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wlease-store-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceLeases);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeWorkspace(): Promise<string> {
    const company = await db
      .insert(companies)
      .values({ name: `c-${randomUUID()}`, issuePrefix: `WL${randomUUID().slice(0, 6).toUpperCase()}` })
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

  it("acquires on a free workspace", async () => {
    const wsId = await makeWorkspace();
    const store = createWorkspaceLeaseStore(db);
    const r = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-1",
      leaseSeconds: 60,
    });
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.leaseId).toBeTruthy();
    }
  });

  it("returns busy when a lease is already held", async () => {
    const wsId = await makeWorkspace();
    const store = createWorkspaceLeaseStore(db);
    const first = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-1",
      leaseSeconds: 60,
    });
    expect(first.acquired).toBe(true);

    const second = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-2",
      leaseSeconds: 60,
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.currentHolderWorkerId).toBe("w-1");
    }
  });

  it("re-acquires after release", async () => {
    const wsId = await makeWorkspace();
    const store = createWorkspaceLeaseStore(db);
    const first = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-1",
      leaseSeconds: 60,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    await store.release({ leaseId: first.leaseId });

    const second = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-2",
      leaseSeconds: 60,
    });
    expect(second.acquired).toBe(true);
    if (second.acquired) {
      expect(second.leaseId).not.toBe(first.leaseId);
    }
  });

  it("renew bumps expires_at; returns false on released lease", async () => {
    const wsId = await makeWorkspace();
    const store = createWorkspaceLeaseStore(db);
    const r = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-1",
      leaseSeconds: 60,
    });
    if (!r.acquired) throw new Error("setup failed");

    expect(await store.renew({ leaseId: r.leaseId, leaseSeconds: 120 })).toBe(true);
    await store.release({ leaseId: r.leaseId });
    expect(await store.renew({ leaseId: r.leaseId, leaseSeconds: 120 })).toBe(false);
  });

  it("release is idempotent", async () => {
    const wsId = await makeWorkspace();
    const store = createWorkspaceLeaseStore(db);
    const r = await store.acquire({
      projectWorkspaceId: wsId,
      runId: null,
      workerId: "w-1",
      leaseSeconds: 60,
    });
    if (!r.acquired) throw new Error("setup failed");
    await store.release({ leaseId: r.leaseId });
    await store.release({ leaseId: r.leaseId });
    // No throw; the second call is a no-op.
  });
});
