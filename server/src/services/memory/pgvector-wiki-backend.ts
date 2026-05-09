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
import type { EmbeddingProvider } from "./embedding.js";
import type {
  ForgetInput,
  LlmClient,
  PageRecallInput,
  PageUpsertInput,
  RecalledPage,
  WikiBackend,
} from "./types.js";

export interface PgvectorWikiBackendOpts {
  embedder?: EmbeddingProvider;
}

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

export function createPgvectorWikiBackend(
  db: Db,
  opts: PgvectorWikiBackendOpts = {},
): WikiBackend {
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

    async recallPages(input: PageRecallInput): Promise<RecalledPage[]> {
      const limit = input.limit ?? 5;
      const expandLinks = input.expandLinks ?? true;

      // Always run keyword (title + content ILIKE). Vector search
      // joins when an embedder is wired up; failures degrade.
      const keywordHits = await runWikiKeywordQuery(db, input, limit);
      let vectorHits: WikiHit[] = [];
      if (opts.embedder) {
        try {
          const [embedding] = await opts.embedder.embed([input.query]);
          vectorHits = await runWikiVectorQuery(db, input, limit, embedding);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[memory.recallPages] vector path failed, falling back", err);
        }
      }

      // Merge by id with weighted union (mirrors recall-rank but
      // operates on the page row shape).
      const merged = mergeWikiHits(vectorHits, keywordHits, limit);

      // 1-hop link expansion. Each linked page contributes a
      // half-weight (0.5) "matchedVia=link" hit. Pulls dedupe by id
      // — if a page appears via embedding AND link, the embedding
      // ranking wins.
      if (expandLinks && merged.length > 0) {
        const seen = new Set(merged.map((m) => m.id));
        const linkRows = await db
          .select({
            id: memoryPages.id,
            slug: memoryPages.slug,
            title: memoryPages.title,
            contentMarkdown: memoryPages.contentMarkdown,
            companyId: memoryPages.companyId,
            userId: memoryPages.userId,
            agentId: memoryPages.agentId,
            sessionId: memoryPages.sessionId,
            fromPageId: memoryPageLinks.fromPageId,
          })
          .from(memoryPageLinks)
          .innerJoin(memoryPages, eq(memoryPageLinks.toPageId, memoryPages.id))
          .where(
            and(
              inArray(
                memoryPageLinks.fromPageId,
                merged.map((m) => m.id),
              ),
              isNull(memoryPages.supersededAt),
            ),
          );

        // Attach linkedPages onto the parent for the response shape,
        // and append the linked rows as separate hits.
        const byParent = new Map<string, Array<{ id: string; slug: string; title: string }>>();
        for (const lr of linkRows) {
          const list = byParent.get(lr.fromPageId) ?? [];
          list.push({ id: lr.id, slug: lr.slug, title: lr.title });
          byParent.set(lr.fromPageId, list);
        }
        for (const m of merged) {
          m.linkedPages = byParent.get(m.id);
        }
        for (const lr of linkRows) {
          if (seen.has(lr.id)) continue;
          seen.add(lr.id);
          merged.push({
            id: lr.id,
            slug: lr.slug,
            title: lr.title,
            contentMarkdown: lr.contentMarkdown,
            scope: scopeKindOf(lr),
            score: 0.5,
            matchedVia: "link",
          });
        }
        merged.sort((a, b) => b.score - a.score);
      }

      return merged.slice(0, limit + (expandLinks ? limit : 0));
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
      // Soft-delete via supersededAt + forget reason. Idempotent —
      // a second call is a no-op because of the supersededAt IS NULL
      // guard. Outbound links from this page are dropped so they
      // don't surface in 1-hop expansion of other pages.
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(memoryPages)
          .set({
            supersededAt: sql`now()`,
            forgetReason: input.reason,
          })
          .where(and(eq(memoryPages.id, input.id), isNull(memoryPages.supersededAt)))
          .returning({ id: memoryPages.id });
        if (row) {
          await tx
            .delete(memoryPageLinks)
            .where(eq(memoryPageLinks.fromPageId, input.id));
          await tx
            .delete(memoryPageLinks)
            .where(eq(memoryPageLinks.toPageId, input.id));
        }
      });
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

// ---------- recallPages internals ----------

interface WikiHit extends RecalledPage {
  rawScore: number;
}

interface WikiRawRow {
  id: string;
  slug: string;
  title: string;
  content_markdown: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  raw_score: number;
}

const WIKI_VECTOR_WEIGHT = 0.7;
const WIKI_KEYWORD_WEIGHT = 0.3;

async function runWikiKeywordQuery(
  db: Db,
  input: PageRecallInput,
  limit: number,
): Promise<WikiHit[]> {
  const queryParam = `%${input.query}%`;
  const userFilter = input.scope.userId
    ? sql` AND (user_id IS NULL OR user_id = ${input.scope.userId})`
    : sql``;
  const agentFilter = input.scope.agentId
    ? sql` AND (agent_id IS NULL OR agent_id = ${input.scope.agentId})`
    : sql``;
  const result = await db.execute(sql`
    SELECT id, slug, title, content_markdown, user_id, agent_id, session_id,
           1.0::double precision AS raw_score
    FROM memory_pages
    WHERE company_id = ${input.scope.companyId}
      AND superseded_at IS NULL
      AND (title ILIKE ${queryParam} OR content_markdown ILIKE ${queryParam})
      ${userFilter}
      ${agentFilter}
    ORDER BY last_linted_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `);
  return rawToWikiHits(result, "embedding");
}

async function runWikiVectorQuery(
  db: Db,
  input: PageRecallInput,
  limit: number,
  embedding: Float32Array,
): Promise<WikiHit[]> {
  const literal = `[${Array.from(embedding).join(",")}]`;
  const userFilter = input.scope.userId
    ? sql` AND (user_id IS NULL OR user_id = ${input.scope.userId})`
    : sql``;
  const agentFilter = input.scope.agentId
    ? sql` AND (agent_id IS NULL OR agent_id = ${input.scope.agentId})`
    : sql``;
  const result = await db.execute(sql`
    SELECT id, slug, title, content_markdown, user_id, agent_id, session_id,
           GREATEST(0.0, 1.0 - (embedding <=> ${literal}::vector))::double precision AS raw_score
    FROM memory_pages
    WHERE company_id = ${input.scope.companyId}
      AND superseded_at IS NULL
      AND embedding IS NOT NULL
      ${userFilter}
      ${agentFilter}
    ORDER BY embedding <=> ${literal}::vector ASC
    LIMIT ${limit}
  `);
  return rawToWikiHits(result, "embedding");
}

function rawToWikiHits(
  result: unknown,
  matchedVia: "embedding" | "link",
): WikiHit[] {
  const rows = (Array.isArray(result) ? result : (result as { rows?: WikiRawRow[] }).rows ?? []) as WikiRawRow[];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    contentMarkdown: r.content_markdown,
    scope: scopeKindOf({ userId: r.user_id, agentId: r.agent_id, sessionId: r.session_id }),
    score: 0,
    matchedVia,
    rawScore: typeof r.raw_score === "number" ? r.raw_score : Number(r.raw_score),
  }));
}

function mergeWikiHits(
  vectorHits: WikiHit[],
  keywordHits: WikiHit[],
  limit: number,
): RecalledPage[] {
  const merged = new Map<string, RecalledPage & { score: number }>();
  for (const h of vectorHits) {
    merged.set(h.id, { ...h, score: clamp(h.rawScore * WIKI_VECTOR_WEIGHT) });
  }
  for (const h of keywordHits) {
    const existing = merged.get(h.id);
    const contribution = clamp(h.rawScore * WIKI_KEYWORD_WEIGHT);
    if (existing) {
      existing.score = clamp(existing.score + contribution);
    } else {
      merged.set(h.id, { ...h, score: contribution });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function clamp(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
