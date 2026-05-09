// Reflection worker — backfills embeddings for memory_entries rows
// that landed with embedding=null (the write path stays fast by
// deferring embedding to this worker; M-3).
//
// Two layers, same pattern as the lease reaper in Plan 2:
//   - embedPendingFacts(db, embedder, batchSize) is the pure tick
//     function: query → embed → update, returning a count for tests
//     and metrics.
//   - startReflectionWorker(...) is the production wire: setInterval
//     calling the tick function, .unref()'d so it doesn't keep the
//     event loop alive for shutdown.
//
// Failure handling: a per-row embed error logs and skips the row;
// the next tick retries it via a fresh batch query. The whole tick
// is wrapped in try/catch so a Postgres outage doesn't crash the
// process.
//
// extract-semantic and ingest-page (M-13/M-14) extend this same
// worker with an additional pass over recently-promoted episodics —
// they share the polling loop, separate stages.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries, memoryPages } from "@paperclipai/db";
import type { EmbeddingProvider } from "./embedding.js";

export interface ReflectionWorkerOpts {
  db: Db;
  // Optional. When absent, the embed stages are skipped (no-op tick).
  // Boot can wire the worker before any embedder is configured —
  // the worker quietly idles until createEmbeddingProvider lands.
  embedder?: EmbeddingProvider;
  // How many rows per tick. Default 32; embedding APIs are happiest
  // with batches up to ~100 (see embedding.ts MAX_BATCH).
  batchSize?: number;
  // Interval in ms. Default 30s.
  intervalMs?: number;
}

export interface EmbedTickResult {
  factsEmbedded: number;
  pagesEmbedded: number;
  errors: number;
}

export async function embedPendingFacts(
  db: Db,
  embedder: EmbeddingProvider,
  batchSize: number,
): Promise<{ embedded: number; errors: number }> {
  const rows = await db
    .select({ id: memoryEntries.id, content: memoryEntries.content })
    .from(memoryEntries)
    .where(and(isNull(memoryEntries.embedding), isNull(memoryEntries.supersededAt)))
    .limit(batchSize);

  if (rows.length === 0) return { embedded: 0, errors: 0 };

  let embedded = 0;
  let errors = 0;
  try {
    const vectors = await embedder.embed(rows.map((r) => r.content));
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].id;
      const vec = Array.from(vectors[i]);
      await db
        .update(memoryEntries)
        .set({ embedding: vec })
        .where(eq(memoryEntries.id, id));
      embedded++;
    }
  } catch (err) {
    errors++;
    // eslint-disable-next-line no-console
    console.warn("[memory.reflection] fact-embed batch failed", err);
  }
  return { embedded, errors };
}

export async function embedPendingPages(
  db: Db,
  embedder: EmbeddingProvider,
  batchSize: number,
): Promise<{ embedded: number; errors: number }> {
  const rows = await db
    .select({ id: memoryPages.id, title: memoryPages.title, contentMarkdown: memoryPages.contentMarkdown })
    .from(memoryPages)
    .where(and(isNull(memoryPages.embedding), isNull(memoryPages.supersededAt)))
    .limit(batchSize);

  if (rows.length === 0) return { embedded: 0, errors: 0 };

  let embedded = 0;
  let errors = 0;
  try {
    const inputs = rows.map((r) => `${r.title}\n\n${r.contentMarkdown}`);
    const vectors = await embedder.embed(inputs);
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].id;
      const vec = Array.from(vectors[i]);
      await db
        .update(memoryPages)
        .set({ embedding: vec, lastLintedAt: sql`now()` })
        .where(eq(memoryPages.id, id));
      embedded++;
    }
  } catch (err) {
    errors++;
    // eslint-disable-next-line no-console
    console.warn("[memory.reflection] page-embed batch failed", err);
  }
  return { embedded, errors };
}

export async function reflectionTick(
  opts: Pick<ReflectionWorkerOpts, "db" | "embedder" | "batchSize">,
): Promise<EmbedTickResult> {
  const batchSize = opts.batchSize ?? 32;
  let factsEmbedded = 0;
  let pagesEmbedded = 0;
  let errors = 0;
  // No-op when no embedder is wired. Boot installs the worker even
  // before an embedder is configured so the cadence exists; once a
  // tenant adds Voyage / OpenAI keys, the next tick picks up the
  // pending backlog.
  if (!opts.embedder) {
    return { factsEmbedded: 0, pagesEmbedded: 0, errors: 0 };
  }
  try {
    const facts = await embedPendingFacts(opts.db, opts.embedder, batchSize);
    factsEmbedded = facts.embedded;
    errors += facts.errors;
    const pages = await embedPendingPages(opts.db, opts.embedder, batchSize);
    pagesEmbedded = pages.embedded;
    errors += pages.errors;
  } catch (err) {
    errors++;
    // eslint-disable-next-line no-console
    console.warn("[memory.reflection] tick crashed", err);
  }
  return { factsEmbedded, pagesEmbedded, errors };
}

export function startReflectionWorker(opts: ReflectionWorkerOpts): { stop: () => void } {
  const interval = opts.intervalMs ?? 30_000;
  const handle = setInterval(() => {
    void reflectionTick(opts);
  }, interval);
  // Don't pin the event loop on shutdown.
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
