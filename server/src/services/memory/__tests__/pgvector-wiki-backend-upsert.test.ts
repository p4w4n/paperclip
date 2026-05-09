// Mocked-Drizzle tests for upsertPage. See
// pgvector-backend-write.test.ts for the rationale on why we don't
// use embedded-postgres here.
//
// Pinning the upsert lifecycle:
//   1. No existing page at (scope, slug) → insert with parent_id null,
//      no supersede, no link delete.
//   2. Existing page at (scope, slug) → insert with parent_id set,
//      old row gets superseded, old links dropped, new links inserted
//      (only for slugs that resolve).

import { describe, expect, it, vi } from "vitest";
import { createPgvectorWikiBackend } from "../pgvector-wiki-backend.js";

interface Capture {
  selects: number;
  inserts: Array<Record<string, unknown> | Record<string, unknown>[]>;
  updates: Array<Record<string, unknown>>;
  deletes: number;
}

function makeFakeDb(opts: {
  existingId?: string;
  linkTargets?: Array<{ id: string; slug: string }>;
}): { db: unknown; cap: Capture } {
  const cap: Capture = { selects: 0, inserts: [], updates: [], deletes: 0 };
  // Each call to tx.select() returns a fresh chain. The chain tracks
  // whether .limit() was called — that's the discriminator between
  // the existing-page lookup (with limit) and the link-target lookup
  // (without limit). Each chain awaits to its own type's payload.
  const buildSelectChain = () => {
    let usedLimit = false;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      innerJoin: () => chain,
      limit: () => {
        usedLimit = true;
        cap.selects += 1;
        return Promise.resolve(opts.existingId ? [{ id: opts.existingId }] : []);
      },
    };
    Object.defineProperty(chain, "then", {
      value: (resolve: (v: unknown) => void) => {
        cap.selects += 1;
        if (usedLimit) {
          resolve(opts.existingId ? [{ id: opts.existingId }] : []);
        } else {
          resolve(opts.linkTargets ?? []);
        }
      },
    });
    return chain;
  };

  const tx = {
    select: vi.fn(() => buildSelectChain()),
    insert: vi.fn(() => ({
      values(v: Record<string, unknown> | Record<string, unknown>[]) {
        cap.inserts.push(v);
        return {
          returning() {
            return Promise.resolve([{ id: "new-page-id" }]);
          },
        };
      },
    })),
    update: vi.fn(() => ({
      set(patch: Record<string, unknown>) {
        cap.updates.push(patch);
        return { where: () => Promise.resolve() };
      },
    })),
    delete: vi.fn(() => ({
      where() {
        cap.deletes += 1;
        return Promise.resolve();
      },
    })),
  };
  return {
    db: {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    cap,
  };
}

describe("createPgvectorWikiBackend.upsertPage", () => {
  it("fresh insert when no existing page at (scope, slug)", async () => {
    const { db, cap } = makeFakeDb({});
    const backend = createPgvectorWikiBackend(db as never);
    const result = await backend.upsertPage({
      scope: { companyId: "co-1", agentId: "ag-1" },
      slug: "auth-middleware",
      title: "Auth Middleware",
      contentMarkdown: "Validates JWT...",
    });
    expect(result.superseded).toBe(false);
    expect(result.id).toBe("new-page-id");
    expect(cap.inserts).toHaveLength(1);
    const inserted = cap.inserts[0] as Record<string, unknown>;
    expect(inserted.parentId).toBeNull();
    expect(inserted.slug).toBe("auth-middleware");
    expect(cap.updates).toHaveLength(0); // no supersede
    expect(cap.deletes).toBe(0); // no old-link drop
  });

  it("creates a new revision when an existing page is present", async () => {
    const { db, cap } = makeFakeDb({ existingId: "old-page-id" });
    const backend = createPgvectorWikiBackend(db as never);
    const result = await backend.upsertPage({
      scope: { companyId: "co-1", agentId: "ag-1" },
      slug: "auth-middleware",
      title: "Auth Middleware",
      contentMarkdown: "Validates JWT (revised)",
    });
    expect(result.superseded).toBe(true);
    expect(cap.inserts).toHaveLength(1);
    const inserted = cap.inserts[0] as Record<string, unknown>;
    expect(inserted.parentId).toBe("old-page-id");
    expect(cap.updates).toHaveLength(1); // supersede
    const patch = cap.updates[0];
    expect(patch.supersededAt).toBeInstanceOf(Date);
    expect(cap.deletes).toBe(1); // old links dropped
  });

  it("links: resolves matching slugs and silently drops non-matching ones", async () => {
    const { db, cap } = makeFakeDb({
      linkTargets: [
        { id: "page-jwt", slug: "jwt-claims" },
        { id: "page-handlers", slug: "route-handlers" },
      ],
    });
    const backend = createPgvectorWikiBackend(db as never);
    await backend.upsertPage({
      scope: { companyId: "co-1" },
      slug: "auth-middleware",
      title: "Auth Middleware",
      contentMarkdown: "...",
      links: [
        { slug: "jwt-claims", linkText: "JWT claim shape" },
        { slug: "nonexistent-page" }, // dropped
        { slug: "route-handlers" },
      ],
    });
    // Two link rows inserted (only resolved slugs); the link-targets
    // select was made; the new-page insert + the link-rows insert
    // both show up.
    const linkInsert = cap.inserts.find(
      (i) => Array.isArray(i) && (i as Record<string, unknown>[])[0]?.fromPageId,
    );
    expect(linkInsert).toBeDefined();
    expect((linkInsert as Record<string, unknown>[]).length).toBe(2);
  });
});
