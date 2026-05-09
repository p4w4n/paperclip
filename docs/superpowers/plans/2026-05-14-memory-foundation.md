# Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-13-memory-knowledge-design.md` — the `memory_entries` table, the `MemoryBackend` plugin contract with the default `pgvector` implementation, the in-process `memory-service`, episodic-write integration into the run lifecycle, recall + prompt-prefix injection into `executeRun`, and the reflection-worker scaffold that consolidates episodic → semantic.

**Architecture:** New `server/src/services/memory/` module owns the `MemoryBackend` interface and the default `pgvector` implementation. The service is wired in two places: (1) `heartbeat.ts` writes episodic entries on every run-event boundary (start, comment-arrived, finish), and (2) `executeRun` injects a `<memory>` prompt-prefix recalled from the entry's scope before invoking the adapter. A new periodic worker (mirroring the `lease-reaper` pattern from `Plan 2` of the distributed-workers spec) embeds pending entries every 60s and performs episodic→semantic extraction every 300s. Tenant isolation is enforced at the service layer — every recall and write is gated on `company_id`.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres), `pgvector` 0.9 with HNSW index. Default embedding model: `voyage-3-large` at 1024-dim with int8 quantization (with a fallback path for `text-embedding-3-large` for tenants without a Voyage account). The 2025-05-13 research brief (`docs/research/2026-05-13-memory-knowledge-research-brief.md`) captures the alternative backends the plugin contract enables: Mem0, Letta, LangMem, Zep / Graphiti, MemoryOS.

**Scope split (this plan covers Plan 1 of 2 for memory):**

- ✅ This plan: schema, write path, recall + decay, prompt-prefix injection, episodic→semantic reflection worker, embedding pipeline, tenant-isolation gate, PII redaction.
- ⏭ Plan 2: procedural memory + skill mining on issue close, operator promotion API (semantic → company scope), MCP server adapter, MemoryBackend plugin contract reference implementation (Mem0), `/admin/memory` UI page, OTel observability.

---

## File Structure

**Created:**

- `packages/db/src/schema/memory_entries.ts` — Drizzle schema for the new table.
- `packages/db/src/migrations/0084_memory_entries.sql` — DDL with the HNSW partial index.
- `server/src/services/memory/types.ts` — `MemoryBackend`, `RecalledEntry`, scope types.
- `server/src/services/memory/pgvector-backend.ts` — default backend.
- `server/src/services/memory/service.ts` — process-wide singleton wrapping the backend with validation, tenant gate, and OTel spans.
- `server/src/services/memory/embedding.ts` — embedding-provider abstraction; default is `voyage-3-large` with `text-embedding-3-large` fallback.
- `server/src/services/memory/reflection-worker.ts` — pure function `(now, findPending, embed, extractSemantic, decay) → void`.
- `server/src/services/memory/extract-semantic.ts` — pure function over an LLM client + episodic entries → semantic facts.
- `server/src/services/memory/decay.ts` — pure function applying salience decay + soft-delete.
- `server/src/services/memory/redact.ts` — PII redaction step (regex + LLM scrubber).
- `server/src/services/memory/__tests__/*.test.ts` — one per file above.
- `server/src/__tests__/memory/integration.test.ts` — end-to-end test against an embedded postgres.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `memoryEntries`.
- `server/src/services/heartbeat.ts` — write episodic entries on run start/finish; inject `<memory>` prompt-prefix in `executeRun`.
- `server/src/index.ts` — start the reflection worker alongside the existing reapers.
- `server/src/config.ts` — add `MEMORY_*` env vars (embedding-provider, embedding-dim, reflection-disabled, decay-rate, forget-threshold, embed-min-salience).

**Migration:** `0084_memory_entries.sql`. Adds `memory_entries` + a partial HNSW index. Hand-edited because drizzle-kit doesn't represent partial-WHERE indexes cleanly (precedent: the workspace-lease partial unique in Plan 4 of the distributed-workers spec).

---

## Conventions used in this plan

Same as the distributed-workers plans:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`. Run a single test by name with `-t "<name>"`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL file alongside the schema change. Hand-edit when drizzle-kit's emit is wrong.
- **Commit style:** conventional commits matching existing history — `feat(server): …`, `feat(db): …`, `test(server): …`. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: write failing test → RED → implement → GREEN → typecheck → commit → push.
- **No placeholder/skeleton commits.** Every commit should leave the tree green (`pnpm -r build && pnpm -r test --run` passes the worker-plan-related test files at minimum).

---

## Task 1: Schema — `memory_entries` table

**Files:**

- Create: `packages/db/src/schema/memory_entries.ts`
- Modify: `packages/db/src/schema/index.ts` — re-export `memoryEntries`
- Generate: `packages/db/src/migrations/0084_memory_entries.sql`

The columns and indexes match the spec:

```ts
// memory_entries shape:
//   id (uuid, pk)
//   company_id (uuid, fk → companies.id, ON DELETE CASCADE)
//   user_id (uuid, fk → auth_users.id, ON DELETE CASCADE, nullable)
//   agent_id (uuid, fk → agents.id, ON DELETE CASCADE, nullable)
//   session_id (uuid, nullable)
//   session_kind ('issue' | 'run' | NULL)
//   kind ('episodic' | 'semantic' | 'procedural')
//   content (text)
//   payload (jsonb, nullable)
//   embedding (vector(1024), nullable until embedded)
//   source_run_id (uuid, fk → heartbeat_runs.id, ON DELETE SET NULL)
//   created_at, last_used_at, use_count, salience, expires_at
//   supersedes_id (uuid, fk → self), superseded_at
```

The HNSW index lives in the migration SQL because drizzle-kit's emit doesn't support `WHERE embedding IS NOT NULL AND superseded_at IS NULL`. Hand-edit:

```sql
CREATE INDEX "memory_entries_embedding_hnsw" ON "memory_entries"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL AND "superseded_at" IS NULL;
```

Pgvector requires the extension. The migration's first statement is `CREATE EXTENSION IF NOT EXISTS vector`.

- [ ] **Step 1: Edit schema** — declare the table with the shape above; mirror the comments from the spec. The vector column uses Drizzle's `customType` since `pgvector` isn't first-class:
  ```ts
  const vector = (dim: number) => customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (v) => `[${v.join(",")}]`,
    fromDriver: (s) => JSON.parse(s as string),
  });
  ```
- [ ] **Step 2: Generate the migration** — `pnpm --filter @paperclipai/db generate`. Rename the auto-named file to `0084_memory_entries.sql` and update `meta/_journal.json` (precedent: Plan 1 Task 2 of distributed-workers).
- [ ] **Step 3: Hand-edit the migration**:
  - Prepend `CREATE EXTENSION IF NOT EXISTS vector;`
  - Replace the auto-generated index for `embedding` with the partial HNSW form above.
- [ ] **Step 4: Whole-repo typecheck** (`pnpm -r typecheck`).
- [ ] **Step 5: Commit + push** as `memory/01-schema`.

---

## Task 2: `MemoryBackend` interface + types

**Files:**

- Create: `server/src/services/memory/types.ts`

This is the plugin contract. No implementation yet — just the shapes the rest of the plan binds to. The contract follows the spec exactly:

```ts
export type MemoryKind = "episodic" | "semantic" | "procedural";

export interface MemoryScope {
  companyId: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKind?: "issue" | "run";
}

export interface WriteInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  payload?: Record<string, unknown>;
  sourceRunId?: string;
}

export interface RecallInput {
  scope: MemoryScope;
  query: string;
  limit?: number; // default 10
  kinds?: MemoryKind[];
}

export interface RecalledEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  payload?: Record<string, unknown>;
  scope: { kind: "user" | "company" | "agent" | "session" };
  score: number; // 0..1
  sourceRunId?: string;
}

export interface ForgetInput {
  id: string;
  reason: "user" | "expired" | "consolidated";
}

export interface MemoryBackend {
  write(input: WriteInput): Promise<{ id: string }>;
  recall(input: RecallInput): Promise<RecalledEntry[]>;
  forget(input: ForgetInput): Promise<void>;
}
```

- [ ] **Step 1: Write the file** as above. No tests yet — the types-only step is verified by tsc when consumers land in Task 3 + 4.
- [ ] **Step 2: Whole-repo typecheck** — green.
- [ ] **Step 3: Commit + push** as `memory/02-types`.

---

## Task 3: pgvector backend — `write` only

**Files:**

- Create: `server/src/services/memory/pgvector-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-backend-write.test.ts`

`write()` returns the inserted row's id. Embedding is left null on write (the reflection worker handles it). Salience defaults to 0.5 per spec. Scope columns map straight from the input.

- [ ] **Step 1: Write failing test.** Use embedded-postgres (`getEmbeddedPostgresTestSupport` + `startEmbeddedPostgresTestDatabase` per the precedent in `server/src/__tests__/access-service.test.ts`). Insert a company + agent fixture; call `write({...})`; assert the row exists with `embedding IS NULL` and `salience = 0.5`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** The backend takes a `Db` in its factory: `createPgvectorMemoryBackend(db: Db): MemoryBackend`. Single Drizzle insert.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/03-write`.

---

## Task 4: Memory service + tenant-isolation gate

**Files:**

- Create: `server/src/services/memory/service.ts`
- Create: `server/src/services/memory/__tests__/service.test.ts`

The service wraps a `MemoryBackend` with three things the spec calls out:

1. **Tenant isolation.** Every call checks the caller's company against the input's company; mismatched company throws.
2. **OTel span.** `paperclip.memory.write` and `paperclip.memory.recall` spans wrap the underlying call (the GenAI semconv from the workers spec is already in the codebase).
3. **Future hook for plugin backend.** The service holds a `setBackend()` method so the plugin system in Plan 2 can swap pgvector for Mem0/Zep at boot.

The service is a process-wide singleton (matches `runDispatcher` from Plan 1 of the workers spec).

- [ ] **Step 1: Write failing tests:**
  - `write()` rejects when caller's company doesn't match the input's `companyId`.
  - `recall()` rejects on mismatched company.
  - `setBackend()` swaps the implementation at runtime; subsequent calls hit the new one.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Reject with `MemoryTenantMismatchError` (new error class).
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/04-service`.

---

## Task 5: Run-event hooks — write episodic on run start/finish

**Files:**

- Modify: `server/src/services/heartbeat.ts` — write an episodic entry on `executeRun` start, and on `markCompleted` / `markFailed` finish.
- Create: `server/src/services/memory/__tests__/run-events.test.ts`

The episodic entries on run boundaries are what give the system a default level of signal without the agent doing anything. Each one carries `sourceRunId`, `companyId`, `agentId`, `sessionId = run.id` (or `issue.id` if available), `sessionKind = "run"` (or "issue"), `content` = a structured one-liner ("Run started for issue 'fix flaky test'", "Run completed: passed all checks").

- [ ] **Step 1: Write failing test.** Drive an `executeRun` against a stubbed adapter; assert an episodic entry exists with the expected scope + content after the run.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Add hooks at the run boundaries; route through `memoryService.write`. Write failures are logged but do not stall the run path (precedent: Plan 2 Task 1 of workers — fire-and-forget pattern with logger.warn-on-throw).
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/05-run-events`.

---

## Task 6: Embedding provider abstraction

**Files:**

- Create: `server/src/services/memory/embedding.ts`
- Create: `server/src/services/memory/__tests__/embedding.test.ts`

Two providers: `voyage-3-large` (default) and `text-embedding-3-large` (fallback). The choice is per-company config; opts injected at boot. Lazy-import each SDK so unit tests don't pay the load cost (precedent: Plan 1 Task 14 of workers — `gcpIdTokenAuthStrategy`).

```ts
export interface EmbeddingProvider {
  id: "voyage-3-large" | "text-embedding-3-large";
  dimension: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

- [ ] **Step 1: Write failing test.** Inject a fake provider whose `embed()` returns a deterministic vector per text; assert the wrapper batches correctly (max-batch = 100 in v1).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — the wrapper plus `createDefaultEmbeddingProvider()` that lazy-imports `voyageai` or `openai`.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/06-embedding`.

---

## Task 7: pgvector backend — `recall` with union-rank

**Files:**

- Modify: `server/src/services/memory/pgvector-backend.ts`
- Create: `server/src/services/memory/__tests__/pgvector-backend-recall.test.ts`

Recall is the meat of the backend. The spec's union-rank weights are: `user > company > agent > session`. Decay is `score = base_score * exp(-age_days / decay_half_life)` where `base_score` is `cosine_sim * salience`. Tie-breaks by `last_used_at`.

The SQL is one query:

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
  AND (user_id IS NULL OR user_id = $user_id)
  AND (agent_id IS NULL OR agent_id = $agent_id)
ORDER BY (sim * salience * scope_weight *
          exp(-(EXTRACT(EPOCH FROM (now() - created_at)) / 86400) / $decay_half_life)) DESC
LIMIT $limit;
```

The trick is keeping the filter cheap. The HNSW index handles `embedding <=> ?`; the rest are b-tree indexed.

- [ ] **Step 1: Write failing test** with three writes at different scopes and salience; assert that `recall()` returns them in the expected union-ranked order.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** On a hit, also `UPDATE memory_entries SET use_count = use_count + 1, last_used_at = now() WHERE id = ANY($ids)`.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/07-recall`.

---

## Task 8: pgvector backend — `forget`

**Files:**

- Modify: `server/src/services/memory/pgvector-backend.ts`
- Modify: `server/src/services/memory/__tests__/pgvector-backend-write.test.ts`

`forget()` is a soft-delete: sets `superseded_at = now()`. The recall query already filters `superseded_at IS NULL`. The reason gets stored in a new `forget_reason` column (small migration).

- [ ] **Step 1: Migration** — add `forget_reason TEXT` column. Drizzle generate + commit alongside the previous migration.
- [ ] **Step 2: Write failing test** — write an entry, forget it with `reason: "user"`, recall does not return it; assert `superseded_at` is set and `forget_reason = "user"`.
- [ ] **Step 3: RED.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/08-forget`.

---

## Task 9: Prompt-prefix `<memory>` injection in `executeRun`

**Files:**

- Modify: `server/src/services/heartbeat.ts` — wrap the prompt with a `<memory>` block recalled from the run's scope before invoking the adapter.
- Create: `server/src/services/memory/__tests__/prompt-prefix.test.ts`

The recall query uses the issue title + body as the anchor. Top-K configurable per-company; default 10. Each entry gets serialized as `[scope] content (sourceRun: ...)`.

```text
<memory>
[company] We use postgres-js, not pg, in this codebase. (sourceRun: ...)
[agent] Last fix for flaky tests was adding waitFor(). (sourceRun: ...)
[session] Earlier in this issue, the failing path was the auth middleware. (sourceRun: ...)
</memory>
```

- [ ] **Step 1: Write failing test.** Seed three memory entries; drive `executeRun`; assert the adapter received a prompt with the `<memory>` block and the entries serialized in scope-priority order.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** The injection happens in the `executeRun` helper, just before the adapter call. Failure to recall (e.g., embedding provider down) logs but does not block — the run proceeds without the memory prefix.
- [ ] **Step 4: GREEN, typecheck, commit + push** as `memory/09-prompt-prefix`.

---

## Task 10: Reflection worker — embedding pipeline

**Files:**

- Create: `server/src/services/memory/reflection-worker.ts`
- Create: `server/src/services/memory/__tests__/reflection-worker.test.ts`
- Modify: `server/src/index.ts` — start the worker alongside the lease + workspace-lease reapers.

Pure function `reflectEmbeddings({ now, findPending, embed, persistEmbeddings })`. Production wires `findPending` to a SQL select on `memory_entries WHERE embedding IS NULL AND superseded_at IS NULL LIMIT 100`. Per-row failures are absorbed; a batch failure (provider outage) logs and the next tick retries.

- [ ] **Step 1: Write failing test** — same shape as the lease-reaper tests in workers Plan 2 Task 2. Stub `findPending` returns 3 rows; stub `embed` returns deterministic vectors; assert `persistEmbeddings` was called with `(id, vector)` pairs.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire** — 60s setInterval in `server/src/index.ts`. `if (typeof reapInterval.unref === "function") reapInterval.unref()` so the worker doesn't keep the event loop alive (precedent: Plan 2 Task 2 of workers).
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/10-embedding-pipeline`.

---

## Task 11: Reflection worker — episodic → semantic extraction

**Files:**

- Create: `server/src/services/memory/extract-semantic.ts`
- Create: `server/src/services/memory/__tests__/extract-semantic.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts` — add the extraction step after the embedding step.

Pure function over (LLM client, episodic entries, existing semantic in scope) → semantic facts. The LLM client is injected so tests use a fake. Production uses the same adapter that the agent's heartbeat uses (claude_local / gemini_local) — but billed to a system agent so the cost is visible.

The extraction prompt asks for structured output:

```json
{ "facts": [
  { "content": "Prefers postgres-js over pg in this codebase",
    "scope": "company" },
  { "content": "Working on the auth middleware in src/middleware/auth.ts",
    "scope": "session" }
] }
```

Dedup against existing semantic memory in scope: cosine-sim > 0.92 means the new fact supersedes the old one (`supersedes_id` set). Below the threshold means new entry.

- [ ] **Step 1: Write failing test** with a fake LLM client returning two facts and one existing semantic entry that's near-identical to one of them; assert one new entry was inserted and one supersedes the old.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire into the worker** — runs every 5 ticks (5 minutes) so we batch episodic before extracting.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/11-extract-semantic`.

---

## Task 12: Salience decay + soft-delete

**Files:**

- Create: `server/src/services/memory/decay.ts`
- Create: `server/src/services/memory/__tests__/decay.test.ts`
- Modify: `server/src/services/memory/reflection-worker.ts` — add the decay step.

Pure function `decay({ now, entries, decayRate, forgetThreshold })` returns two lists: `updated` (new salience values) and `toForget` (ids whose salience fell below the threshold). The worker applies them via `forget()` and a bulk `UPDATE`.

Defaults: `decayRate = 0.05/day` (entries lose 5% salience per day not recalled), `forgetThreshold = 0.05`. Configurable per-company.

- [ ] **Step 1: Write failing test** — pure function over a small array; assert the decayed values and the cutoff list.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Wire into the worker** — runs daily (every 24h * 60min / 5min = 288 ticks).
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/12-decay`.

---

## Task 13: PII redaction step

**Files:**

- Create: `server/src/services/memory/redact.ts`
- Create: `server/src/services/memory/__tests__/redact.test.ts`
- Modify: `server/src/services/memory/service.ts` — apply redaction in `write()`.

Two layers: a regex sweep for the obvious shapes (API keys, email addresses, phone numbers, AWS access keys, GCP SA emails) and an opt-in LLM-based scrubber for free-text content. Disabled per-company by default; enabled via config.

```ts
export interface RedactInput { content: string; companyId: string; }
export interface RedactResult { redacted: string; redactionCount: number; }
export function redactPii(input: RedactInput, opts: RedactOpts): Promise<RedactResult>;
```

- [ ] **Step 1: Write failing tests** — string with email, phone, API key sk-...; assert the result has them replaced by `[REDACTED]`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** the regex layer; the LLM layer ships as a stub returning the input unchanged in v1 (the prompt + provider integration lives in Plan 2).
- [ ] **Step 4: Wire** into `service.write()` — apply before the backend call.
- [ ] **Step 5: GREEN, typecheck, commit + push** as `memory/13-redact`.

---

## Task 14: Whole-repo green build + ROADMAP touch-up

- [ ] **Step 1: Full repo build + tests**
  ```
  pnpm -r build
  pnpm --filter '!@paperclipai/server' -r test
  pnpm --filter @paperclipai/server exec vitest run \
    src/services/memory/__tests__/ src/__tests__/memory/
  ```
  Expected: green.

- [ ] **Step 2: Update `ROADMAP.md`** — flip the Memory / Knowledge milestone from ⚪ to 🚧 (foundation done; Plan 2 to follow).

- [ ] **Step 3: Commit + push** as `memory/14-roadmap`.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage:** every section of `docs/superpowers/specs/2026-05-13-memory-knowledge-design.md` that this plan claims to cover (schema + write + recall + retrieval-augmentation + reflection + decay + tenant isolation + PII) has at least one task. Procedural memory, MCP server, plugin backend reference, admin UI, OTel observability — all explicitly Plan 2.
- [ ] **No placeholders:** search the plan for "TBD", "TODO", "implement later", "fill in details" — should be zero hits.
- [ ] **Type consistency:** schema column names match `MemoryBackend` interface input names — `companyId` ↔ `company_id`, `sessionId` ↔ `session_id`, etc.
- [ ] **Commit hygiene:** every task ends with a green build (`pnpm -r build && targeted memory tests`).
- [ ] **Tenant isolation tests cover both write and recall paths.** A cross-company recall MUST throw, not silently return zero rows.

## What's not done after this plan

- **Procedural memory.** No skill mining on issue close. The `procedural` kind exists in the schema enum but no producer writes it. Plan 2.
- **Operator promotion API.** The "promote a learned skill from agent scope to company scope" workflow lives in Plan 2.
- **MCP server adapter.** Plan 2.
- **Plugin backend reference.** The `MemoryBackend` interface is in place; a Mem0-backed reference plugin lands in Plan 2.
- **Admin UI.** `/admin/memory` UI page is Plan 2.
- **OTel metrics + named-span dashboards.** The basic span wrappers are in place from Task 4; the full metric set + dashboard JSON is Plan 2.
- **`AGENTS.md` auto-import** as company-scoped semantic memory (open question 5 from the spec). Deferred.
- **Bi-temporal validity / Zep-style graph memory.** Deferred to a graph plugin (open question from the spec).
- **In-loop memory paging (Letta).** v1 ships the MCP tool surface (Plan 2) but doesn't require adapters to use it.

---

*Drafted 2026-05-14 against `spec-tier1` branch. Review with: spec author + ops lead. Plan 2 follows once procedural + MCP + plugin backend + UI are pinned.*
