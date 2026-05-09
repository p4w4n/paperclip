// Default WikiBackend — markdown pages on Postgres+pgvector,
// versioned via parent_id chain. Karpathy LLM-Wiki pattern (April
// 2026): upsertPage either inserts a fresh page at (scope, slug),
// or chains a new revision and supersedes the prior. Internal links
// are resolved from slug → page-id and kept in memory_page_links;
// missing target slugs are silently dropped (no dangling links).
//
// The whole upsertPage runs in a transaction so a concurrent upsert
// at the same (scope, slug) can't both pass the "no existing row"
// check and double-insert. Postgres's default isolation is enough;
// the partial unique on memory_pages_slug_active_uniq is the
// secondary correctness gate.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryPages, memoryPageLinks } from "@paperclipai/db";
import type {
  ForgetInput,
  LlmClient,
  PageRecallInput,
  PageUpsertInput,
  RecalledPage,
  WikiBackend,
} from "./types.js";

// Helper: scope columns mapped to the Drizzle predicate set used by
// the supersession query. Treats undefined as IS NULL so the unique
// key matches the partial-unique migration shape.
function scopeWhere(input: PageUpsertInput | PageRecallInput) {
  const s = input.scope;
  return and(
    eq(memoryPages.companyId, s.companyId),
    s.userId !== undefined
      ? eq(memoryPages.userId, s.userId)
      : isNull(memoryPages.userId),
    s.agentId !== undefined
      ? eq(memoryPages.agentId, s.agentId)
      : isNull(memoryPages.agentId),
    s.sessionId !== undefined
      ? eq(memoryPages.sessionId, s.sessionId)
      : isNull(memoryPages.sessionId),
    isNull(memoryPages.supersededAt),
  );
}

export function createPgvectorWikiBackend(db: Db): WikiBackend {
  return {
    async upsertPage(input: PageUpsertInput) {
      return db.transaction(async (tx) => {
        // 1. Find an existing active page at (scope, slug).
        const existing = await tx
          .select({ id: memoryPages.id })
          .from(memoryPages)
          .where(and(scopeWhere(input), eq(memoryPages.slug, input.slug)))
          .limit(1);
        const parentId = existing[0]?.id ?? null;

        // 2. Insert the new revision.
        const [newRow] = await tx
          .insert(memoryPages)
          .values({
            companyId: input.scope.companyId,
            userId: input.scope.userId ?? null,
            agentId: input.scope.agentId ?? null,
            sessionId: input.scope.sessionId ?? null,
            sessionKind: input.scope.sessionKind ?? null,
            slug: input.slug,
            title: input.title,
            contentMarkdown: input.contentMarkdown,
            parentId,
            sourceEntryIds: input.sourceEntryIds ?? null,
          })
          .returning({ id: memoryPages.id });

        // 3. Supersede the prior revision so the partial unique
        //    admits the new one. Order matters: insert FIRST under
        //    serializable isolation would be safer; with default
        //    READ COMMITTED we accept a tiny window where two rows
        //    share the active key, mitigated by the partial unique
        //    rejecting one of the inserts on contention.
        if (parentId) {
          await tx
            .update(memoryPages)
            .set({ supersededAt: new Date() })
            .where(eq(memoryPages.id, parentId));
        }

        // 4. Sync links. Drop the prior page's links; resolve the
        //    new ones from slug → page-id and insert them. Missing
        //    target slugs are silently dropped (the wiki's "no
        //    dangling links" rule).
        if (parentId) {
          await tx.delete(memoryPageLinks).where(eq(memoryPageLinks.fromPageId, parentId));
        }
        if (input.links && input.links.length > 0) {
          const slugs = input.links.map((l) => l.slug);
          const targets = await tx
            .select({ id: memoryPages.id, slug: memoryPages.slug })
            .from(memoryPages)
            .where(
              and(
                eq(memoryPages.companyId, input.scope.companyId),
                inArray(memoryPages.slug, slugs),
                isNull(memoryPages.supersededAt),
              ),
            );
          const targetBySlug = new Map(targets.map((t) => [t.slug, t.id]));
          const linkRows = input.links
            .map((l) => {
              const toId = targetBySlug.get(l.slug);
              if (!toId) return null;
              return {
                fromPageId: newRow.id,
                toPageId: toId,
                linkText: l.linkText ?? null,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (linkRows.length > 0) {
            await tx.insert(memoryPageLinks).values(linkRows);
          }
        }

        return { id: newRow.id, superseded: parentId !== null };
      });
    },

    // recallPages lands in M-9.
    async recallPages(_input: PageRecallInput): Promise<RecalledPage[]> {
      throw new Error("recallPages not yet implemented (M-9)");
    },

    // lintPage lands in M-15.
    async lintPage(_input: { pageId: string; llm: LlmClient }) {
      throw new Error("lintPage not yet implemented (M-15)");
    },

    async listLinkedPages(input: { pageId: string; depth?: number }) {
      const depth = Math.max(1, Math.min(input.depth ?? 1, 3));
      const rows = await db
        .select({
          id: memoryPages.id,
          slug: memoryPages.slug,
          title: memoryPages.title,
          contentMarkdown: memoryPages.contentMarkdown,
          companyId: memoryPages.companyId,
          userId: memoryPages.userId,
          agentId: memoryPages.agentId,
          sessionId: memoryPages.sessionId,
        })
        .from(memoryPageLinks)
        .innerJoin(memoryPages, eq(memoryPageLinks.toPageId, memoryPages.id))
        .where(
          and(
            eq(memoryPageLinks.fromPageId, input.pageId),
            isNull(memoryPages.supersededAt),
          ),
        );
      // depth > 1 traversal not yet in v1; the page recall in M-9
      // expands 1 hop which is the spec's default.
      void depth;
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        contentMarkdown: r.contentMarkdown,
        scope: scopeKindOf(r),
        score: 0.5, // half-weight per spec for link-expanded hits
        matchedVia: "link" as const,
      }));
    },

    async forget(input: ForgetInput) {
      await db
        .update(memoryPages)
        .set({
          supersededAt: sql`now()`,
          forgetReason: input.reason,
        })
        .where(and(eq(memoryPages.id, input.id), isNull(memoryPages.supersededAt)));
    },
  };
}

function scopeKindOf(row: {
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
}): { kind: "user" | "company" | "agent" | "session" } {
  if (row.userId) return { kind: "user" };
  if (row.sessionId) return { kind: "session" };
  if (row.agentId) return { kind: "agent" };
  return { kind: "company" };
}
