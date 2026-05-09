// Mocked Drizzle test for the write path. Avoids embedded-postgres
// because the test environment doesn't ship pgvector — full
// integration coverage of vector(1024) writes lives behind a
// pgvector-required suite (out of scope for this commit; planned in
// the follow-up memory tests work).
//
// What we cover here: the backend constructs the right INSERT shape
// and returns the inserted id. SQL semantics (ON CONFLICT, partial
// indexes, vector encoding) are verified by manual review of the
// migration + this code.

import { describe, expect, it, vi } from "vitest";
import { createPgvectorMemoryBackend } from "../pgvector-backend.js";

function makeFakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  // The minimum chain createPgvectorMemoryBackend actually calls.
  const builder = {
    values(v: Record<string, unknown>) {
      inserted.push(v);
      return builder;
    },
    returning() {
      return Promise.resolve([{ id: "fake-id-1" }]);
    },
  };
  return {
    db: {
      insert: vi.fn(() => builder),
      update: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    inserted,
  };
}

describe("createPgvectorMemoryBackend.write", () => {
  it("inserts an episodic entry with scope columns and returns its id", async () => {
    const { db, inserted } = makeFakeDb();
    const backend = createPgvectorMemoryBackend(db);
    const result = await backend.write({
      scope: {
        companyId: "co-1",
        agentId: "ag-1",
        sessionId: "iss-1",
        sessionKind: "issue",
      },
      kind: "episodic",
      content: "Run started for issue 'fix flaky test'",
      sourceRunId: "run-1",
    });
    expect(result.id).toBe("fake-id-1");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      companyId: "co-1",
      agentId: "ag-1",
      sessionId: "iss-1",
      sessionKind: "issue",
      kind: "episodic",
      content: "Run started for issue 'fix flaky test'",
      sourceRunId: "run-1",
    });
  });

  it("nulls out optional scope columns when not provided", async () => {
    const { db, inserted } = makeFakeDb();
    const backend = createPgvectorMemoryBackend(db);
    await backend.write({
      scope: { companyId: "co-1" },
      kind: "semantic",
      content: "Prefers postgres-js",
    });
    expect(inserted[0]).toMatchObject({
      companyId: "co-1",
      userId: null,
      agentId: null,
      sessionId: null,
      sessionKind: null,
      kind: "semantic",
    });
  });
});
