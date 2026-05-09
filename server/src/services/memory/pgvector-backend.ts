// Default MemoryBackend — fact-per-row storage on Postgres+pgvector.
// Embedding is left null on write (the reflection worker handles it
// via the embedding pipeline in M-12). Salience defaults to 0.5
// (matches the spec). Scope columns map straight from the input;
// recall ranks across them with the union-rank query.
//
// pgvector availability: the migration in M-1 wraps the partial HNSW
// index in DO blocks so creation succeeds on environments without
// the extension; recall queries below catch the "operator does not
// exist" error and fall through to keyword-only ranking. Write/forget
// paths don't depend on pgvector.

import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries } from "@paperclipai/db";
import type { EmbeddingProvider } from "./embedding.js";
import { mergeRecallResults, type ScoredHit } from "./recall-rank.js";
import type {
  ForgetInput,
  MemoryBackend,
  MemoryKind,
  RecallInput,
  RecalledEntry,
  WriteInput,
} from "./types.js";

export interface PgvectorBackendOpts {
  embedder?: EmbeddingProvider;
}

export function createPgvectorMemoryBackend(
  db: Db,
  opts: PgvectorBackendOpts = {},
): MemoryBackend {
  return {
    async write(input: WriteInput) {
      const [row] = await db
        .insert(memoryEntries)
        .values({
          companyId: input.scope.companyId,
          userId: input.scope.userId ?? null,
          agentId: input.scope.agentId ?? null,
          sessionId: input.scope.sessionId ?? null,
          sessionKind: input.scope.sessionKind ?? null,
          kind: input.kind,
          content: input.content,
          payload: (input.payload ?? null) as Record<string, unknown> | null,
          sourceRunId: input.sourceRunId ?? null,
          // embedding stays null — reflection worker (M-12) populates
          // asynchronously. Salience + use_count + created_at use
          // their schema defaults (0.5, 0, now()).
        })
        .returning({ id: memoryEntries.id });
      return { id: row.id };
    },

    async recall(input: RecallInput): Promise<RecalledEntry[]> {
      const limit = input.limit ?? 10;
      const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;

      // Always run keyword search; it serves as the pgvector-absent
      // fallback and contributes to ranking even when vectors are
      // available.
      const keywordHits = await runKeywordQuery(db, input, limit, kinds);

      // Vector path: only when an embedder is wired up. Failures
      // (extension missing, OOM, network) are caught and degrade to
      // keyword-only — recall must not throw on partial-stack
      // environments.
      let vectorHits: ScoredHit[] = [];
      if (opts.embedder) {
        try {
          const [embedding] = await opts.embedder.embed([input.query]);
          vectorHits = await runVectorQuery(db, input, limit, kinds, embedding);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[memory.recall] vector path failed, falling back", err);
        }
      }

      const merged = mergeRecallResults(vectorHits, keywordHits, limit);
      return merged.map((h) => ({
        id: h.id,
        kind: h.kind,
        content: h.content,
        payload: h.payload ?? undefined,
        scope: { kind: h.scopeKind },
        score: h.score,
        sourceRunId: h.sourceRunId ?? undefined,
      }));
    },

    async forget(input: ForgetInput) {
      await db
        .update(memoryEntries)
        .set({
          supersededAt: new Date(),
          forgetReason: input.reason,
        })
        .where(and(eq(memoryEntries.id, input.id), isNull(memoryEntries.supersededAt)));
    },
  };
}

// ---------- internals ----------

interface RawRow {
  id: string;
  kind: string;
  content: string;
  payload: Record<string, unknown> | null;
  source_run_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  raw_score: number;
}

function deriveScopeKind(row: {
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
}): "user" | "company" | "agent" | "session" {
  if (row.session_id) return "session";
  if (row.agent_id) return "agent";
  if (row.user_id) return "user";
  return "company";
}

async function runKeywordQuery(
  db: Db,
  input: RecallInput,
  limit: number,
  kinds: MemoryKind[] | null,
): Promise<ScoredHit[]> {
  const scopeFilter = buildScopeFilter(input);
  const kindFilter = kinds
    ? sql` AND kind = ANY(${kinds})`
    : sql``;
  const queryParam = `%${input.query}%`;

  // Simple ILIKE-rank: 1.0 if the query string appears, 0 otherwise.
  // Tightening to ts_rank_cd is a Plan 2 concern (FTS column not
  // populated yet).
  const result = await db.execute(sql<RawRow>`
    SELECT id, kind, content, payload, source_run_id, user_id, agent_id, session_id,
           1.0::double precision AS raw_score
    FROM memory_entries
    WHERE company_id = ${input.scope.companyId}
      AND superseded_at IS NULL
      AND content ILIKE ${queryParam}
      ${scopeFilter}
      ${kindFilter}
    ORDER BY last_used_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `);
  return rowsToHits(result as unknown as { rows?: RawRow[] } | RawRow[]);
}

async function runVectorQuery(
  db: Db,
  input: RecallInput,
  limit: number,
  kinds: MemoryKind[] | null,
  embedding: Float32Array,
): Promise<ScoredHit[]> {
  const scopeFilter = buildScopeFilter(input);
  const kindFilter = kinds ? sql` AND kind = ANY(${kinds})` : sql``;
  const literal = `[${Array.from(embedding).join(",")}]`;

  // Cosine distance via the <=> operator (pgvector). raw_score is
  // 1 - distance, clamped to [0,1].
  const result = await db.execute(sql<RawRow>`
    SELECT id, kind, content, payload, source_run_id, user_id, agent_id, session_id,
           GREATEST(0.0, 1.0 - (embedding <=> ${literal}::vector))::double precision AS raw_score
    FROM memory_entries
    WHERE company_id = ${input.scope.companyId}
      AND superseded_at IS NULL
      AND embedding IS NOT NULL
      ${scopeFilter}
      ${kindFilter}
    ORDER BY embedding <=> ${literal}::vector ASC
    LIMIT ${limit}
  `);
  return rowsToHits(result as unknown as { rows?: RawRow[] } | RawRow[]);
}

function buildScopeFilter(input: RecallInput) {
  // The union-rank approach: we don't restrict to an exact scope
  // match — rows in broader scopes (e.g. company-only) should be
  // discoverable from a session call. Plan 2 adds a salience boost
  // for narrower scopes; for now ranking is purely score-driven.
  const parts = [];
  if (input.scope.userId) {
    parts.push(sql` AND (user_id IS NULL OR user_id = ${input.scope.userId})`);
  }
  if (input.scope.agentId) {
    parts.push(sql` AND (agent_id IS NULL OR agent_id = ${input.scope.agentId})`);
  }
  if (parts.length === 0) return sql``;
  return sql.join(parts, sql``);
}

function rowsToHits(result: { rows?: RawRow[] } | RawRow[]): ScoredHit[] {
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as MemoryKind,
    content: r.content,
    payload: r.payload,
    sourceRunId: r.source_run_id,
    scopeKind: deriveScopeKind(r),
    rawScore: typeof r.raw_score === "number" ? r.raw_score : Number(r.raw_score),
  }));
}
