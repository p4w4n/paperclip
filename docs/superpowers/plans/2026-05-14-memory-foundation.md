# Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-13-memory-knowledge-design.md` (revised 2026-05-14 to incorporate the Karpathy LLM-Wiki pattern, gist 442a6bf, April 2026). This plan delivers: the `memory_entries` (facts) and `memory_pages` (wiki pages) + `memory_page_links` tables, the `MemoryBackend` and `WikiBackend` plugin contracts with default `pgvector` implementations, the in-process `memory-service`, episodic-write integration into the run lifecycle, recall + prompt-prefix injection (`<memory>` for facts, `<wiki>` for pages) into `executeRun`, and the reflection worker that runs the **Ingest** (episodic → semantic → page) and **Lint** (daily page review) operations.

**Architecture:** New `server/src/services/memory/` module owns both backend interfaces and the default pgvector implementations. The service is wired in two places: (1) `heartbeat.ts` writes episodic entries on every run-event boundary (start, comment-arrived, finish); (2) `executeRun` injects `<memory>` and `<wiki>` prompt-prefix blocks before invoking the adapter. A new periodic worker (mirroring the `lease-reaper` pattern from Plan 2 of the distributed-workers spec) embeds pending entries + pages every 60s, ingests episodic→semantic→page every 5 minutes, and lints pages daily. Tenant isolation is enforced at the service layer — every recall and write is gated on `company_id`.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres), `pgvector` 0.9 with HNSW index. Default embedding model: `voyage-3-large` at 1024-dim with int8 quantization (with a fallback path for `text-embedding-3-large`). Pages are markdown; internal links are tracked in a `memory_page_links` graph table.

**Scope split (this plan covers Plan 1 of 2 for memory):**

- ✅ This plan: facts schema + pages schema + page-links graph; write/recall/forget for facts; upsert/recall/lint for pages; Ingest pipeline (episodic→semantic→page); Lint pipeline (daily page review); decay; tenant isolation; PII redaction; prompt-prefix injection of both `<memory>` and `<wiki>`.
- ⏭ Plan 2: procedural memory + skill mining on issue close, operator promotion API (semantic → company scope; agent-scoped page → company scope), MCP server adapter for both `paperclip://memory/...` and `paperclip://wiki/...` resources, plugin reference implementations (Mem0 for facts; external markdown source for pages), `/admin/memory` UI page (with page revision diff view), full OTel observability.

---

## File Structure

**Created:**

- `packages/db/src/schema/memory_entries.ts` — Drizzle schema for the facts table.
- `packages/db/src/schema/memory_pages.ts` — Drizzle schema for the wiki-pages table.
- `packages/db/src/schema/memory_page_links.ts` — Drizzle schema for the link graph.
- `packages/db/src/migrations/0084_memory_foundation.sql` — DDL with the HNSW partial indexes + the page-slug partial unique.
- `server/src/services/memory/types.ts` — `MemoryBackend`, `WikiBackend`, scope types, recalled-entry / recalled-page shapes.
- `server/src/services/memory/pgvector-backend.ts` — default fact backend.
- `server/src/services/memory/pgvector-wiki-backend.ts` — default page backend.
- `server/src/services/memory/service.ts` — process-wide singleton wrapping both backends with validation, tenant gate, OTel spans.
- `server/src/services/memory/embedding.ts` — embedding-provider abstraction.
- `server/src/services/memory/reflection-worker.ts` — pure function `(now, findPending, embed, ingest, lint, decay) → void`.
- `server/src/services/memory/extract-semantic.ts` — pure function over an LLM client + episodic entries → semantic facts.
- `server/src/services/memory/ingest-page.ts` — pure function over an LLM client + N semantic facts → page upsert input.
- `server/src/services/memory/lint-page.ts` — pure function over an LLM client + page + cited entries + linked pages → revised page-or-noop.
- `server/src/services/memory/decay.ts` — pure function applying salience decay + soft-delete.
- `server/src/services/memory/redact.ts` — PII redaction step (regex + LLM scrubber).
- `server/src/services/memory/__tests__/*.test.ts` — one per file above.
- `server/src/__tests__/memory/integration.test.ts` — end-to-end test against an embedded postgres covering Ingest + Lint cycles.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `memoryEntries`, `memoryPages`, `memoryPageLinks`.
- `server/src/services/heartbeat.ts` — write episodic entries on run start/finish; inject `<memory>` + `<wiki>` prompt-prefix in `executeRun`.
- `server/src/index.ts` — start the reflection worker alongside the existing reapers.
- `server/src/config.ts` — add `MEMORY_*` env vars (embedding-provider, reflection-disabled, ingest-page-min-facts, lint-disabled, lint-interval-hours, decay-rate, forget-threshold, embed-min-salience).

**Migration:** `0084_memory_foundation.sql`. Adds `memory_entries`, `memory_pages`, `memory_page_links` plus all indexes including the partial HNSW and the page-slug partial unique. Hand-edited because drizzle-kit doesn't represent partial-WHERE indexes cleanly (precedent: the workspace-lease partial unique in Plan 4 of the distributed-workers spec).

---

## Conventions used in this plan

Same as the distributed-workers plans:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL file alongside the schema change. Hand-edit when drizzle-kit's emit is wrong.
- **Commit style:** conventional commits matching existing history — `feat(server): …`, `feat(db): …`, `test(server): …`. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: write failing test → RED → implement → GREEN → typecheck → commit → push.
- **No placeholder/skeleton commits.** Every commit should leave the tree green.

---

## Task 1: Schema — `memory_entries`, `memory_pages`, `memory_page_links`

**Files:**

- Create: `packages/db/src/schema/memory_entries.ts`
- Create: `packages/db/src/schema/memory_pages.ts`
- Create: `packages/db/src/schema/memory_page_links.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/0084_memory_foundation.sql`

The columns and indexes match the spec — see the spec for the SQL. Three tables in one migration. Vector columns use Drizzle's `customType` since `pgvector` isn't first-class:

```ts
const vector = (dim: number) => customType<{ data: number[]; driverData: string }>({
  dataType: () => `vector(${dim})`,
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (s) => JSON.parse(s as string),
});
```

The HNSW indexes and the page-slug partial unique go in the migration SQL because drizzle-kit's emit doesn't support `WHERE`-bounded indexes:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Partial HNSW indexes — only embedded, non-superseded rows.
CREATE INDEX "memory_entries_embedding_hnsw" ON "memory_entries"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL AND "superseded_at" IS NULL;

CREATE INDEX "memory_pages_embedding_hnsw" ON "memory_pages"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL AND "superseded_at" IS NULL;

-- Partial unique on (scope, slug). NULL columns participate in
-- equality with NULL via the COALESCE trick or are scoped via
-- composite. Use the explicit form for clarity:
CREATE UNIQUE INDEX "memory_pages_slug_active_uniq" ON "memory_pages"
  ("company_id", COALESCE("agent_id"::text, ''),
   COALESCE("user_id"::text, ''), COALESCE("session_id"::text, ''), "slug")
  WHERE "superseded_at" IS NULL;
```

- [ ] **Step 1: Edit the three schema files** with the columns from the spec.
- [ ] **Step 2: Re-export** from `packages/db/src/schema/index.ts`.
- [ ] **Step 3: Generate the migration** — `pnpm --filter @paperclipai/db generate`. Rename the auto-named file to `0084_memory_foundation.sql` and update `meta/_journal.json`.
- [ ] **Step 4: Hand-edit the migration**:
  - Prepend `CREATE EXTENSION IF NOT EXISTS vector;`
  - Replace the auto-generated indexes for `embedding` (both tables) with the partial HNSW form.
  - Replace the auto-generated unique on `memory_pages` with the partial-WHERE form.
- [ ] **Step 5: Whole-repo typecheck** (`pnpm -r typecheck`).
- [ ] **Step 6: Commit + push** as `memory/01-schema`.

---

## Task 2: `MemoryBackend` and `WikiBackend` interfaces + types

**Files:**

- Create: `server/src/services/memory/types.ts`

This is the plugin contract. No implementation yet — just the shapes the rest of the plan binds to. See the spec for the full interfaces. Both backends share `MemoryScope`. `RecalledEntry` (facts) and `RecalledPage` (pages) are distinct shapes — pages carry `linkedPages` for graph traversal.

- [ ] **Step 1: Write the file** as in the spec. No tests yet — types-only step is verified by tsc when consumers land in Tasks 3-7.
- [ ] **Step 2: Whole-repo typecheck** — green.
- [ ] **Step 3: Commit + push** as `memory/02-types`.

---

## Task 3: pgvector backend — facts `write`

**Files:**

- Create: `server/src/services/memory/pgvector-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-backend-write.test.ts`

`write()` returns the inserted row's id. Embedding left null on write (the reflection worker handles it). Salience defaults to 0.5. Scope columns map straight from input.

- [ ] **Step 1: Write failing test.** Use embedded-postgres (precedent in `server/src/__tests__/access-service.test.ts`). Insert company + agent fixture; call `write({...})`; assert the row exists with `embedding IS NULL` and `salience = 0.5`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Single Drizzle insert. Factory: `createPgvectorMemoryBackend(db: Db): MemoryBackend`.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/03-write-fact`.

---

## Task 4: pgvector wiki backend — `upsertPage`

**Files:**

- Create: `server/src/services/memory/pgvector-wiki-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-wiki-backend-upsert.test.ts`

`upsertPage()` is the meat of the wiki layer. Logic:

1. Look up `(company_id, agent_id, user_id, session_id, slug) WHERE superseded_at IS NULL`.
2. If a row exists: insert a new revision with `parent_id = existing.id`, then `UPDATE existing SET superseded_at = now()`. Return `{ id: new, superseded: true }`.
3. If no row: insert fresh. Return `{ id: new, superseded: false }`.
4. Update `memory_page_links`: `DELETE FROM memory_page_links WHERE from_page_id = old.id`, then resolve each link's `slug` to a page id (within the same company/scope) and insert `(new.id, target_id)`. Missing target pages are dropped (no dangling links).

The whole sequence runs in a transaction — Postgres's serializable isolation prevents the race where two concurrent upserts both see "no existing row."

- [ ] **Step 1: Write failing tests:**
  - Insert page A. Verify single row, `parent_id` null.
  - Upsert same `(scope, slug)` again — old row gets `superseded_at` set, new row's `parent_id` points at old.
  - Insert page A with one link to page B (which exists). Verify `memory_page_links` has the row.
  - Insert page A with a link to a non-existent slug — link is silently dropped, no error.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Wrap in `db.transaction(...)` for the supersede + link sync.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/04-upsert-page`.

---

## Task 5: Memory service + tenant-isolation gate

**Files:**

- Create: `server/src/services/memory/service.ts`
- Create: `server/src/services/memory/__tests__/service.test.ts`

The service wraps both backends with three things the spec calls out:

1. **Tenant isolation.** Every call checks the caller's company against the input's `companyId`; mismatched company throws `MemoryTenantMismatchError`.
2. **OTel spans.** `paperclip.memory.write`, `paperclip.memory.recall`, `paperclip.wiki.upsert`, `paperclip.wiki.recall`, `paperclip.wiki.lint`.
3. **Future hook for plugin backends.** `setMemoryBackend()` and `setWikiBackend()` for runtime swap.

The service is a process-wide singleton (matches `runDispatcher` from Plan 1 of the workers spec).

- [ ] **Step 1: Write failing tests:**
  - `write()` rejects on cross-company input.
  - `recall()` rejects on cross-company input.
  - `upsertPage()` rejects on cross-company input.
  - `setMemoryBackend()` and `setWikiBackend()` swap implementations at runtime.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Reject with `MemoryTenantMismatchError`.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/05-service`.

---

## Task 6: Run-event hooks — write episodic on run start/finish

**Files:**

- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/services/memory/__tests__/run-events.test.ts`

The episodic entries on run boundaries are what give the system a default level of signal without the agent doing anything. Each one carries `sourceRunId`, `companyId`, `agentId`, `sessionId = run.id` (or `issue.id`), `sessionKind = "run"` (or "issue"), `content` = a structured one-liner.

- [ ] **Step 1: Write failing test.** Drive `executeRun` against a stubbed adapter; assert an episodic entry exists with the expected scope + content after the run.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Hooks at run boundaries; route through `memoryService.write`. Write failures are logged but do not stall the run path (precedent: Plan 2 Task 1 of workers — fire-and-forget pattern).
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/06-run-events`.

---

## Task 7: Embedding provider abstraction

**Files:**

- Create: `server/src/services/memory/embedding.ts`
- Create: `server/src/services/memory/__tests__/embedding.test.ts`

Two providers: `voyage-3-large` (default) and `text-embedding-3-large` (fallback). Per-company config; opts injected at boot. Lazy-import each SDK so unit tests don't pay the load cost (precedent: Plan 1 Task 14 of workers — `gcpIdTokenAuthStrategy`).

```ts
export interface EmbeddingProvider {
  id: "voyage-3-large" | "text-embedding-3-large";
  dimension: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

- [ ] **Step 1: Write failing test** with an injected fake provider; assert batching (max-batch = 100).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/07-embedding`.

---

## Task 8: pgvector backend — facts `recall` with union-rank

**Files:**

- Modify: `server/src/services/memory/pgvector-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-backend-recall.test.ts`

Union-rank weights from spec: `user > company > agent > session`. Decay `score = base_score * exp(-age_days / decay_half_life)` where `base_score = cosine_sim * salience`. Tie-breaks by `last_used_at`.

```sql
SELECT id, kind, content, payload, source_run_id,
       (1 - (embedding <=> $query_embedding)) AS sim,
       salience, created_at, last_used_at,
       (CASE
         WHEN user_id    IS NOT NULL THEN 1.0
         WHEN agent_id   IS NULL AND session_id IS NULL THEN 0.85  -- company
         WHEN agent_id   IS NOT NULL AND session_id IS NULL THEN 0.7  -- agent
         ELSE 0.5  -- session
        END) AS scope_weight
FROM memory_entries
WHERE company_id = $1
  AND superseded_at IS NULL
  AND embedding IS NOT NULL
  AND ($kinds IS NULL OR kind = ANY($kinds))
ORDER BY (sim * salience * scope_weight *
          exp(-(EXTRACT(EPOCH FROM (now() - created_at)) / 86400) / $decay_half_life)) DESC
LIMIT $limit;
```

On a hit, also `UPDATE memory_entries SET use_count = use_count + 1, last_used_at = now() WHERE id = ANY($ids)`.

- [ ] **Step 1: Write failing test** — three writes at different scopes + salience; assert union-ranked order.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/08-recall-fact`.

---

## Task 9: pgvector wiki backend — `recallPages` with link expansion

**Files:**

- Modify: `server/src/services/memory/pgvector-wiki-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-wiki-backend-recall.test.ts`

Pages use the same union-rank logic but with a smaller default limit (5 — pages are larger than facts). When `expandLinks: true`, after the initial result set, query `memory_page_links` for 1-hop neighbors and append them at half-weight.

- [ ] **Step 1: Write failing tests:**
  - Three pages at different scopes; assert union-ranked order.
  - Pages with internal links + `expandLinks: true` returns linked pages at half-weight.
  - Pages with internal links + `expandLinks: false` returns only the direct hits.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Two queries: the first does HNSW recall, the second resolves links for ids in the result set. Compose in TS, not SQL.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/09-recall-page`.

---

## Task 10: pgvector backend — `forget`

**Files:**

- Modify: `server/src/services/memory/pgvector-backend.ts`
- Modify: `server/src/services/memory/__tests__/pgvector-backend-write.test.ts`

`forget()` is a soft-delete: sets `superseded_at = now()` and `forget_reason`. The recall query already filters `superseded_at IS NULL`. Same operation works on both `memory_entries` and `memory_pages` — the wiki backend implements its own thin `forget` that updates `memory_pages`.

- [ ] **Step 1: Write failing test** — write an entry, forget it with `reason: "user"`, recall does not return it; assert `superseded_at` and `forget_reason = "user"` are set.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** for both backends.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/10-forget`.

---

## Task 11: Prompt-prefix `<memory>` + `<wiki>` injection in `executeRun`

**Files:**

- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/services/memory/__tests__/prompt-prefix.test.ts`

Two recall calls anchor on the issue title + body:

- `<memory>`: top-K facts, default 10, scope-priority order.
- `<wiki>`: top-K pages with `expandLinks: true`, default 5.

Serialization:

```text
<memory>
[company] We use postgres-js, not pg, in this codebase. (sourceRun: ...)
[agent] Last fix for flaky tests was adding waitFor(). (sourceRun: ...)
[session] Earlier in this issue, the failing path was the auth middleware. (sourceRun: ...)
</memory>

<wiki>
## auth-middleware (company)
The auth middleware validates JWT tokens via better-auth. It runs before
the request reaches the route handler...

> See also: jwt-claims, route-handlers
</wiki>
```

- [ ] **Step 1: Write failing test.** Seed three memory entries + two pages with one link; drive `executeRun`; assert the adapter received both blocks with content and link-references.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Injection happens just before the adapter call. Recall failures (e.g., embedding provider down) log but do not block — the run proceeds without the prefix blocks.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/11-prompt-prefix`.

---

## Task 12: Reflection worker — embedding pipeline

**Files:**

- Create: `server/src/services/memory/reflection-worker.ts`
- Create: `server/src/services/memory/__tests__/reflection-worker-embed.test.ts`
- Modify: `server/src/index.ts` — start the worker alongside the lease + workspace-lease reapers.

Pure function `reflectEmbeddings({ now, findPending, embed, persistEmbeddings })`. Production wires `findPending` to a SQL select on **both** `memory_entries WHERE embedding IS NULL AND superseded_at IS NULL LIMIT 50` and `memory_pages WHERE embedding IS NULL AND superseded_at IS NULL LIMIT 50`. Per-row failures absorbed; batch failure logs and the next tick retries.

- [ ] **Step 1: Write failing test** (precedent: lease-reaper tests in workers Plan 2 Task 2). Stub returns 3 entries + 2 pages; stub `embed` returns deterministic vectors; assert `persistEmbeddings` was called with the right `(table, id, vector)` triples.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire** — 60s setInterval in `server/src/index.ts`. `if (typeof reapInterval.unref === "function") reapInterval.unref()`.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/12-embedding-pipeline`.

---

## Task 13: Reflection worker — Ingest stage 1 (episodic → semantic)

**Files:**

- Create: `server/src/services/memory/extract-semantic.ts`
- Create: `server/src/services/memory/__tests__/extract-semantic.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts`

Pure function over (LLM client, episodic entries, existing semantic in scope) → semantic facts. LLM injected so tests use a fake. Production uses the same adapter that the agent's heartbeat uses, billed to a system agent.

Extraction asks for structured output:

```json
{ "facts": [
  { "content": "Prefers postgres-js over pg in this codebase",
    "scope": "company" },
  { "content": "Working on the auth middleware in src/middleware/auth.ts",
    "scope": "session" }
] }
```

Dedup: cosine-sim > 0.92 against existing semantic at the same scope means supersession.

- [ ] **Step 1: Write failing test** with a fake LLM client returning two facts and one near-identical existing semantic entry; assert one new entry inserted, one supersedes the old.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire** into the worker — runs every 5 ticks (5 minutes).
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/13-extract-semantic`.

---

## Task 14: Reflection worker — Ingest stage 2 (semantic → page)

**Files:**

- Create: `server/src/services/memory/ingest-page.ts`
- Create: `server/src/services/memory/__tests__/ingest-page.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts`

When N (configurable, default 5) semantic facts accumulate at a scope without a page covering them, the worker:

1. Group facts by topical similarity (cosine-sim cluster, threshold 0.7).
2. For each cluster, derive a slug (LLM call: "give a short kebab-case slug for this topic") and check if a page exists at the scope with that slug.
3. If a page exists, fetch + pass to LLM with the new facts: "merge these into the page; produce updated markdown + a list of links to other pages by slug." Then `upsertPage`.
4. If no page exists, ask the LLM to draft fresh. Then `upsertPage`.

The LLM is asked to declare links explicitly (the gist's pattern). Links resolve to page-ids in the wiki backend.

- [ ] **Step 1: Write failing tests:**
  - 5 semantic facts at company scope, no existing page → fresh page upserted; `source_entry_ids` set.
  - 3 facts at company scope on a topic where a page exists → page revision created with merged content; `parent_id` chained.
  - 5 facts that cluster into 2 topics → 2 page upserts.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Cluster via in-memory cosine-sim against the embeddings (already populated from Task 12).
- [ ] **Step 4: Wire** into the worker — runs after extract-semantic, every 5 ticks.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/14-ingest-page`.

---

## Task 15: Reflection worker — Lint pipeline (daily page review)

**Files:**

- Create: `server/src/services/memory/lint-page.ts`
- Create: `server/src/services/memory/__tests__/lint-page.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts`

Pure function `lintPage({ pageId, llm, db })` that:

1. Fetches the page + cited entries (`source_entry_ids` resolved) + 1-hop linked pages.
2. Asks the LLM: "Are any facts in this page stale or contradicted by the cited entries' current state? Should the page be split (too long)? Are any links missing?"
3. LLM returns `{ status: 'clean' | 'stale' | 'contradicted' | 'needs_split', revisedContent: string | null, notes: string }`.
4. If `revisedContent` is non-null, `upsertPage` it (creates a new revision); otherwise just update `last_linted_at` + `lint_status` + `lint_notes`.

The Lint scheduler walks `memory_pages WHERE last_linted_at < now() - interval '1 day'` LIMIT 20 per company per tick; runs once per day per company by default.

- [ ] **Step 1: Write failing tests:**
  - Page with no contradictions → `status: 'clean'`, no upsert.
  - Page with a cited entry now superseded by a contradicting one → `status: 'contradicted'`, revised page upserted; `parent_id` chained.
  - Page over the size threshold → `status: 'needs_split'`; no auto-action in v1 (operator decides).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire** into the worker — runs daily.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/15-lint`.

---

## Task 16: Salience decay + soft-delete

**Files:**

- Create: `server/src/services/memory/decay.ts`
- Create: `server/src/services/memory/__tests__/decay.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts`

Pure function `decay({ now, entries, pages, decayRate, forgetThreshold })` returns lists of updates and ids to forget. The worker applies them via `forget()` and a bulk `UPDATE`.

Defaults: `decayRate = 0.05/day` (entries lose 5% salience per day not recalled), `forgetThreshold = 0.05`. Configurable per-company.

Pages decay separately — but unlike facts, a stale page is not auto-forgotten; it gets `lint_status = 'stale'` and the operator decides via the admin UI (Plan 2).

- [ ] **Step 1: Write failing test** — pure function over a small array; assert decayed values, cutoff list, and that pages are flagged stale rather than forgotten.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire** — daily tick (288 ticks at 5-minute cadence).
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/16-decay`.

---

## Task 17: PII redaction step

**Files:**

- Create: `server/src/services/memory/redact.ts`
- Create: `server/src/services/memory/__tests__/redact.test.ts`
- Modify: `server/src/services/memory/service.ts`

Two layers: regex sweep for obvious shapes (API keys, emails, phone numbers, AWS keys, GCP SA emails) and an opt-in LLM scrubber for free-text. Disabled per-company by default; enabled via config.

Applied in `service.write()` AND `service.upsertPage()` — both fact and page content go through redaction before hitting the backend.

```ts
export interface RedactInput { content: string; companyId: string; }
export interface RedactResult { redacted: string; redactionCount: number; }
export function redactPii(input: RedactInput, opts: RedactOpts): Promise<RedactResult>;
```

- [ ] **Step 1: Write failing tests** — strings with email, phone, API key `sk-...`; assert replacement with `[REDACTED]`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** the regex layer; LLM layer ships as a stub returning input unchanged in v1 (full integration in Plan 2).
- [ ] **Step 4: Wire** into both `service.write()` and `service.upsertPage()`.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/17-redact`.

---

## Task 18: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1: Full repo build + targeted tests**
  ```
  pnpm -r build
  pnpm --filter '!@paperclipai/server' -r test
  pnpm --filter @paperclipai/server exec vitest run \
    src/services/memory/__tests__/ src/__tests__/memory/
  ```
  Expected: green.

- [ ] **Step 2: Update `ROADMAP.md`** — flip the Memory / Knowledge milestone from ⚪ to 🚧 (foundation done; Plan 2 to follow). Reference both the spec and the Karpathy gist as design sources.

- [ ] **Step 3: Commit + push** as `memory/18-roadmap`.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** every section of the spec that this plan claims to cover has at least one task. **Karpathy three-layer model**: raw layer is existing primitives ✓; wiki layer is `memory_pages` + `memory_page_links` (Tasks 1, 4, 9, 14, 15) ✓; schema layer reuses `AGENTS.md` (no new code). **Ingest** = Tasks 13 + 14. **Lint** = Task 15. **Query** = Tasks 8 + 9 + 11. Procedural memory, MCP server, plugin backend reference, admin UI, full OTel observability — all explicitly Plan 2.
- [ ] **No placeholders:** zero hits for "TBD", "TODO", "implement later".
- [ ] **Type consistency:** schema column names match `MemoryBackend` and `WikiBackend` interface input names — `companyId` ↔ `company_id`, `sessionId` ↔ `session_id`, etc.
- [ ] **Commit hygiene:** every task ends with a green build (`pnpm -r build && targeted memory tests`).
- [ ] **Tenant isolation tests cover write, recall, AND upsertPage.** A cross-company recall MUST throw, not silently return zero rows.
- [ ] **Page revision chain** — every Lint and every `upsertPage` produces a new row with `parent_id` set; old row gets `superseded_at`. The chain is verified in tests (Task 4 + Task 15).

## What's not done after this plan

- **Procedural memory.** The `procedural` kind exists in the schema enum but no producer writes it. Skill mining on issue close lands in Plan 2.
- **Operator promotion API** (semantic → company scope; agent-page → company-page). Plan 2.
- **MCP server adapter** for both `paperclip://memory/<scope>` and `paperclip://wiki/<scope>/<slug>`. Plan 2.
- **Plugin backend reference.** `MemoryBackend` and `WikiBackend` interfaces are in place; reference plugins (Mem0 for facts; an external markdown source for pages) land in Plan 2.
- **Admin UI** with **page revision diff view** for rolling back bad lints. Plan 2.
- **OTel metrics + named-span dashboards.** Basic span wrappers from Task 5; full metric set + dashboard JSON is Plan 2.
- **`AGENTS.md` auto-import** as company-scoped wiki pages (open question 7 from spec). Deferred.
- **Bi-temporal validity / Zep-style graph memory.** Deferred to a graph plugin. Note: paperclip's `memory_page_links` is page-level graph, not the fact-level temporal graph Zep ships.
- **In-loop memory paging (Letta).** v1 ships the MCP tool surface (Plan 2) but doesn't require adapters to use it.
- **Auto-act on `needs_split` lint signal.** v1 reports the signal; the LLM-driven page split lands in Plan 2.

---

*Drafted 2026-05-14, revised 2026-05-14 to incorporate the Karpathy LLM-Wiki pattern. Review with: spec author + ops lead. Plan 2 follows once procedural + MCP + plugin backend + UI are pinned.*
