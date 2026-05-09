# Memory + Knowledge Design

> Spec for the **Memory / Knowledge** roadmap milestone. Grounded in the May 2026 state-of-the-art (Mem0, Letta, LangMem, Zep/Graphiti, MemoryOS, A-MEM) plus the **Karpathy LLM-Wiki pattern** (gist 442a6bf, April 2026). See `docs/research/2026-05-13-memory-knowledge-research-brief.md` for the wider research and `https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f` for the wiki-pattern source.

## Problem

Paperclip agents are stateless beyond a single run. Each `heartbeat_run` starts cold: the agent re-reads `AGENTS.md`, the issue thread, and any documents the human linked. There is no durable, retrievable memory of *what an agent learned in a prior run*, *what a company has decided in the past*, or *what skills have proven useful for an issue type*. Operators compensate by stuffing prompts with hand-curated context, which scales badly.

Specifically:

- **Per-agent memory.** An agent that fixes a flaky test once should not have to rediscover the cause in the next run on a sibling test. Today the only continuity is the issue's comment thread, which is lossy.
- **Per-company memory.** "We use postgres-js, not pg, in this codebase" is the kind of decision that should be canonical for every agent in the company. Today it lives in `AGENTS.md` files maintained by hand.
- **Per-issue session memory.** A long-running issue with N runs against the same workspace currently re-reads the whole comment thread on each run. Earlier runs' summaries are not consolidated.
- **Cross-issue procedural memory.** "When tests break this way, the fix is usually X" — patterns learned from completed issues should compound.
- **Stateless RAG fails for compounding knowledge.** Vector-chunk retrieval over raw transcripts is the default tool, but it can't *correct itself*: a stale fact stays in the index until manually purged. The Karpathy LLM-Wiki gist (April 2026) is explicit about this gap — agents need an *LLM-curated* knowledge layer, not just an embedding index.

## Goals

1. Four-scope memory: **user / company / agent / session** (the Mem0-2026 consensus). Reads union-rank across scopes; writes target the most-specific scope where the fact is true.
2. Episodic, semantic, and procedural memory types. Episodic captured automatically (run events, comments); semantic + procedural derived by an async reflection worker.
3. **Karpathy three-layer model:** an **immutable raw layer** (existing `heartbeat_runs` + `document_revisions`), an **LLM-curated wiki layer** (new `memory_pages` table — markdown pages at each scope, with internal links, embedded for retrieval), and an **agent-rules layer** (existing `AGENTS.md` / `SKILL.md`). The three layers communicate through named operations: **Ingest** (raw → entries → pages), **Query** (recall pages + facts), **Lint** (LLM reviews pages for staleness / contradictions).
4. Postgres-native default storage (`pgvector` HNSW) so the existing OSS install gets memory without a new datastore. Pluggable backends (`MemoryBackend` for facts, `WikiBackend` for pages) so production tenants can swap to Mem0, Zep, or Letta via the existing plugin system.
5. Memory is exposed to agents during a run as a typed tool (`recall`, `write`, `forget`, `recall_pages`) and via implicit retrieval-augmentation in the prompt-prefix (no tool call required for "remember last 5 facts and 2 pages about this user").
6. MCP server adapter so external agents can read/write paperclip memory; MCP client adapter so paperclip agents can consume external memory backends.
7. GDPR-shaped retention: per-scope TTL + per-user delete; tenant-isolated by company.

## Karpathy LLM-Wiki pattern adoption

The April-2026 Karpathy gist describes a system where every interaction surfaces *three* artifacts:

```
raw/   — append-only logs of every interaction, tool call, output (immutable)
wiki/  — LLM-maintained markdown pages that compound over time (mutable)
schema — agent rules + page-organization conventions (config)
```

Reads go through `wiki/` first, falling back to `raw/` only when a page doesn't exist or is stale. Writes never modify `raw/`; they only update `wiki/`. A periodic `Lint` pass walks `wiki/` and asks an LLM to fix contradictions, mark stale facts, split pages that grew too long, link pages that should reference each other.

This maps onto paperclip's primitives directly:

| Karpathy layer | Paperclip primitive |
|---|---|
| `raw/` immutable logs | `heartbeat_runs` + `heartbeat_run_events` + `document_revisions` (already in core) |
| `wiki/` LLM-curated pages | `memory_pages` (new table — markdown content, internal links, embedded) |
| `schema.md` agent rules | `AGENTS.md` + `SKILL.md` (already in core; cross-tool standard) |
| `Ingest` op | reflection-worker: episodic entry → semantic entry → page upsert |
| `Query` op | the `recall()` + `recall_pages()` calls in the contract |
| `Lint` op | reflection-worker periodic step: re-read each page + cited entries, ask LLM to revise |

The fact-per-row taxonomy (Mem0 4-scope) and the page-per-topic taxonomy (Karpathy wiki) coexist: facts are the unit of evidence; pages are the unit of compounded knowledge. A page cites the entries that contributed to it (`source_entry_ids`), so the `raw → wiki` provenance is auditable.

## Non-goals (v1)

- **Graph / temporal memory** (Zep/Graphiti's bi-temporal facts). Useful for "X was true until T" reasoning; v1 keeps facts append-only with last-write-wins on conflict. Graph backend lands as an opt-in plugin.
- **Cross-tenant federated memory.** Each company is a hard isolation boundary; v1 has no shared memory pool across companies.
- **Memory-driven agent loop reflection** (Letta-style core/recall/archival paging at the runtime level). Reflection in v1 is a background worker, not an in-loop tool call. Letta-style paging requires an adapter rewrite that we'd rather not couple to v1.
- **Multi-modal memory** (images, audio). Text-only.
- **Real-time multi-agent shared scratchpad.** Two agents working concurrently on the same issue read each other's memory only after a write commits, not via streaming.
- **Multi-author conflict resolution on wiki pages.** v1 assumes the lint pass is the single writer; concurrent agent writes through `upsertPage` use last-write-wins with `parent_id` chain. CRDT-shaped collaborative editing is deferred.
- **Bidirectional sync to external wiki tools** (Notion, Confluence, MediaWiki). Out of scope; an external wiki is its own product surface.

## Architecture

```
                    ┌────────────────────────────────────┐
                    │  paperclip control plane           │
                    │                                    │
                    │  ┌──────────────────────────────┐  │
                    │  │  memory-service              │  │
                    │  │  facts: write/recall/forget  │  │
                    │  │  pages: upsert/recall/lint   │  │
                    │  └────┬───────────────┬─────────┘  │
                    │       │               │            │
                    │  ┌────▼─────┐   ┌────▼──────────┐  │
                    │  │ Memory   │   │ Wiki Backend  │  │
                    │  │ Backend  │   │ (default:     │  │
                    │  │ (default:│   │  pgvector +   │  │
                    │  │ pgvector)│   │  markdown)    │  │
                    │  └─────┬────┘   └─────┬─────────┘  │
                    │        │              │            │
                    │  ┌─────▼──────────────▼─────────┐  │
                    │  │  memory_entries (facts)      │  │
                    │  │  memory_pages (wiki pages)   │  │
                    │  │  memory_page_links           │  │
                    │  └──────────────────────────────┘  │
                    └────────────────────────────────────┘
                                  ▲
                                  │ async
                    ┌─────────────┴───────────────────┐
                    │  reflection-worker              │
                    │  (background)                   │
                    │                                 │
                    │  Ingest:  episodic → semantic   │
                    │           semantic → page       │
                    │  Lint:    revise stale pages    │
                    │  Decay:   salience drop + GC    │
                    └─────────────────────────────────┘
```

### Schema

#### Facts table — `memory_entries`

```sql
-- The base entry. Type-poor on purpose: a JSONB payload + scope keys
-- + content + embedding lets us swap the backend without a schema
-- change. The plugin contract is what callers depend on.
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scope columns. Exactly one of (agent_id, session_id) may be set;
  -- company_id is always set; user_id is optional.
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID            REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id   UUID            REFERENCES agents(id)     ON DELETE CASCADE,
  session_id UUID,                  -- issue_id OR heartbeat_run_id
  session_kind TEXT,                -- 'issue' | 'run' | NULL
  -- Memory type.
  kind TEXT NOT NULL,               -- 'episodic' | 'semantic' | 'procedural'
  -- Content + structured payload.
  content     TEXT  NOT NULL,
  payload     JSONB,
  -- Embedding for retrieval. Nullable until embedded.
  embedding   VECTOR(1024),
  -- Provenance.
  source_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  -- Lifecycle.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  use_count   INT NOT NULL DEFAULT 0,
  salience    REAL NOT NULL DEFAULT 0.5,
  expires_at  TIMESTAMPTZ,
  -- Supersession (last-write-wins on conflict).
  supersedes_id UUID REFERENCES memory_entries(id) ON DELETE SET NULL,
  superseded_at TIMESTAMPTZ,
  forget_reason TEXT
);

CREATE INDEX memory_entries_company_idx ON memory_entries (company_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_agent_idx   ON memory_entries (agent_id)   WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_session_idx ON memory_entries (company_id, session_kind, session_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_user_idx    ON memory_entries (user_id)    WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_embedding_hnsw ON memory_entries
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND superseded_at IS NULL;
```

#### Wiki pages — `memory_pages`

Pages are the LLM-curated knowledge layer. Each page is a markdown document at one scope (a page never spans scopes; cross-scope synthesis happens at recall time via the union ranker). Pages are versioned via `parent_id` chain — every lint or upsert produces a new revision; older revisions stay for audit. The unique key is `(company_id, agent_id, session_id, slug) WHERE superseded_at IS NULL` so each scope gets at most one active page per slug.

```sql
CREATE TABLE memory_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID            REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id   UUID            REFERENCES agents(id)     ON DELETE CASCADE,
  -- Pages CAN have session scope (e.g., "summary of issue #123"), but
  -- typical pages live at agent or company scope where they compound.
  session_id   UUID,
  session_kind TEXT,        -- 'issue' | 'run' | NULL
  -- Identity.
  slug    TEXT NOT NULL,    -- 'auth-middleware' | 'deployment-process' | etc.
  title   TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  -- Embedding over the full page content for retrieval.
  embedding VECTOR(1024),
  -- Versioning.
  parent_id UUID REFERENCES memory_pages(id) ON DELETE SET NULL,
  -- Provenance — which entries contributed to this page in the most
  -- recent ingest/lint pass. UI surfaces this as "sources".
  source_entry_ids UUID[],
  -- Lifecycle.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_linted_at TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  use_count      INT NOT NULL DEFAULT 0,
  -- Lint signals — what the most recent lint pass found.
  lint_status   TEXT,    -- 'clean' | 'stale' | 'contradicted' | 'needs_split'
  lint_notes    TEXT,
  -- Supersession (chain of revisions).
  superseded_at TIMESTAMPTZ,
  forget_reason TEXT
);

CREATE INDEX memory_pages_company_idx     ON memory_pages (company_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_pages_agent_idx       ON memory_pages (agent_id)   WHERE superseded_at IS NULL;
CREATE INDEX memory_pages_user_idx        ON memory_pages (user_id)    WHERE superseded_at IS NULL;
CREATE INDEX memory_pages_session_idx     ON memory_pages (company_id, session_kind, session_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_pages_embedding_hnsw  ON memory_pages
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX memory_pages_slug_active_uniq ON memory_pages
  (company_id, agent_id, user_id, session_id, slug)
  WHERE superseded_at IS NULL;
```

#### Internal links — `memory_page_links`

Wiki pages reference each other. The link table tracks them as a graph so the recall step can traverse from a hit to its neighbors (one hop by default, configurable).

```sql
CREATE TABLE memory_page_links (
  -- Both ends are always within the same company; we don't enforce
  -- via FK (would require composite key) but the service layer does.
  from_page_id UUID NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
  to_page_id   UUID NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
  link_text    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id)
);

CREATE INDEX memory_page_links_to_idx ON memory_page_links (to_page_id);
```

### Memory service contract

Two backend interfaces — facts and pages — composed by the `memory-service`. Plugin authors implement either or both to swap providers (Mem0 has facts; Karpathy-style external wikis would implement pages).

```ts
// Facts (the Mem0-shaped half).
interface MemoryBackend {
  write(input: WriteInput): Promise<{ id: string }>;
  recall(input: RecallInput): Promise<RecalledEntry[]>;
  forget(input: ForgetInput): Promise<void>;
}

// Wiki pages (the Karpathy-shaped half).
interface WikiBackend {
  // Upsert by (scope, slug). If a page with that key exists and is
  // active, it gets superseded with parent_id chained to the new
  // revision.
  upsertPage(input: PageUpsertInput): Promise<{ id: string; superseded: boolean }>;
  recallPages(input: PageRecallInput): Promise<RecalledPage[]>;
  // Lint a single page: re-read content + cited entries + linked
  // pages, ask the LLM to revise. Returns the new revision id when
  // changes were made; null when the page was already clean.
  lintPage(input: { pageId: string; llm: LlmClient }): Promise<{
    newRevisionId: string | null;
    status: 'clean' | 'stale' | 'contradicted' | 'needs_split';
    notes: string;
  }>;
  // Page graph traversal — links from / to a page.
  listLinkedPages(input: { pageId: string; depth?: number }): Promise<RecalledPage[]>;
}

interface PageUpsertInput {
  scope: MemoryScope;
  slug: string;
  title: string;
  contentMarkdown: string;
  sourceEntryIds?: string[];
  // Internal links by slug; the service resolves to page ids and
  // updates memory_page_links.
  links?: Array<{ slug: string; linkText?: string }>;
}

interface PageRecallInput {
  scope: MemoryScope;
  query: string;
  limit?: number;        // default 5 (pages are larger than facts; cap tighter)
  expandLinks?: boolean; // default true — pull in 1-hop linked pages
}

interface RecalledPage {
  id: string;
  slug: string;
  title: string;
  contentMarkdown: string;
  scope: { kind: 'user' | 'company' | 'agent' | 'session' };
  score: number;             // 0..1
  matchedVia: 'embedding' | 'link';
  // The pages directly linked from this one, when expandLinks is true.
  linkedPages?: Array<{ id: string; slug: string; title: string }>;
}
```

`MemoryScope`, `WriteInput`, `RecallInput`, `RecalledEntry`, `ForgetInput` are unchanged from the Mem0-shaped contract — see `server/src/services/memory/types.ts` once Plan 1 lands.

### Reflection worker

A new periodic job alongside the lease reaper (Plan 2 Task 2 of the workers spec). Three steps in distinct cadences.

#### Step 1 — Embed pending (every tick)

Any `memory_entries` or `memory_pages` row with `embedding IS NULL` gets an embedding (voyage-3-large default; configurable). Per-row failures are absorbed; provider outages defer.

#### Step 2 — Ingest (every 5 ticks)

Two-stage compaction:

1. **episodic → semantic.** For each new episodic entry, an LLM call produces 0..N candidate semantic facts (`{"prefers": "postgres-js", "for": "this-codebase"}`). Dedupe against existing semantic memory at the same scope; supersede on cosine-sim > 0.92.
2. **semantic → page.** When N (configurable, default 5) related semantic facts accumulate at a scope without a page, the worker calls the LLM with the facts + the slug naming convention from the schema layer (`AGENTS.md`-style hints), produces a fresh markdown page, and `upsertPage`s it. When facts cite an existing page (via overlap with `source_entry_ids`), the page gets re-ingested.

Both stages are themselves heartbeat_runs charged to a system agent so the cost is visible in the budget UI.

#### Step 3 — Lint (daily; configurable)

For each company:

1. Walk `memory_pages WHERE last_linted_at < now() - interval '1 day'`.
2. For each page, fetch (a) the page content, (b) the cited entries' current state (some may be superseded), (c) the directly linked pages.
3. Ask the LLM: "Are any facts in this page stale or contradicted by the cited entries? Should the page be split? Are any links missing?"
4. Apply the LLM's revision via `upsertPage`. The old revision stays via `parent_id` chain.

Lint cost is bounded: at most one LLM call per page per day. A company with 200 pages and a $0.01/page lint cost = $2/day. Disabled per-company is a config flag.

#### Step 4 — Decay (daily)

`salience` drops by `decay_rate` per day for entries not recalled; entries below `forget_threshold` get soft-deleted via `forget(reason: "expired")`. Pages decay independently — a never-recalled page fades to `lint_status = 'stale'` for an operator to review before purging.

### Retrieval-augmentation in run prompts

Three hooks into the existing `executeRun` path in `heartbeat.ts`:

- **Pre-run prompt-prefix injection — facts.** The system prompt gets a `<memory>` block populated by `recall({ scope, query: <issue title + body> })`. Top-K configurable, default 10.
- **Pre-run prompt-prefix injection — pages.** A separate `<wiki>` block populated by `recallPages({ scope, query: <issue title + body>, expandLinks: true })`. Top-K configurable, default 5. Linked pages within 1 hop of a hit are appended at half-weight.
- **In-run tool calls.** Adapters that support tool calls get `recall_memory(query)`, `recall_pages(query)`, and `remember(content, kind)` exposed via the MCP runtime services from Phase 3 of the workers spec.

### MCP integration

- **Server.** A built-in MCP server exposes:
  - `paperclip://memory/<scope>` — fact-level recall (Mem0-shape)
  - `paperclip://wiki/<scope>/<slug>` — page-level read (Karpathy-shape)
  - Tools: `recall`, `recall_pages`, `remember`, `upsert_page` (auth-gated)
- **Client.** The plugin system gains `MemoryBackend` and `WikiBackend` adapters that proxy to external MCP servers.

## Lifecycle and states

### Fact lifecycle

```
[user message / run output]
        │
        ▼
[memory.write episodic]
        │
        ▼
[reflection-worker: embed → extract semantic → ingest into page]
        │
        ▼
[memory.recall during next run]
        │
        ▼
[salience++, last_used_at = now()]
```

### Page lifecycle

```
[N semantic facts accumulate at a scope]
        │
        ▼
[reflection-worker.ingest creates page revision 1]
        │
        ▼
[run reads page via recall_pages → page is cited in next run's prompt]
        │
        ▼
[next run produces new episodic → cycle through ingest again]
        │
        ▼
[reflection-worker.ingest creates page revision 2 (parent_id = rev 1)]
        │
        ▼
[daily lint pass reviews page; if stale, produces revision 3]
        │
   (no recalls for forget_threshold_days)
        ▼
[lint marks lint_status = 'stale'; operator decides]
```

## Observability

- New OTel spans (`paperclip.memory.write`, `paperclip.memory.recall`, `paperclip.memory.reflect`, `paperclip.wiki.upsert`, `paperclip.wiki.recall`, `paperclip.wiki.lint`) under the existing `gen_ai.agent.*` semconv.
- Metrics: `paperclip_memory_entries_total{company,kind}`, `paperclip_wiki_pages_total{company,scope_kind}`, `paperclip_wiki_lint_revisions_total{status}`, `paperclip_memory_recall_latency_ms`, `paperclip_wiki_recall_latency_ms`, `paperclip_memory_reflect_cost_tokens`, `paperclip_wiki_lint_cost_tokens`.
- Admin UI: `/admin/memory` page surfaces per-company entry + page counts, top-recalled, reflection-worker queue depth, lint pipeline status.

## Failure modes

| Failure | Behavior |
|---|---|
| pgvector index unavailable / corrupt | Recall falls back to keyword search on `content` (LIKE); slower but doesn't break runs |
| Embedding provider outage | New entries / pages queue with `embedding IS NULL`; reflection-worker drains when provider returns |
| Reflection-worker behind | Episodic still readable; semantic / pages lag; explicit `paperclip_memory_reflection_lag_seconds` metric pages on |
| Lint produces a worse page than the previous revision | The `parent_id` chain preserves the prior revision; an operator can roll back via the admin UI |
| External MCP backend (plugin) returns nothing | Adapter falls back to local pgvector; logs `memory_backend_degraded` once |
| Conflicting semantic facts on a page | Lint pass detects via the LLM and either chooses the newer fact (last-write-wins) or marks `lint_status = 'contradicted'` for an operator |
| Memory leakage across tenants | All queries are gated on `company_id`; the recall service rejects requests where `company_id` doesn't match the caller's session |
| Page graph cycle | `listLinkedPages(depth=N)` short-circuits on revisited ids; no traversal corruption |

## Phasing

1. **Schema + write path (facts + pages).** `memory_entries` and `memory_pages` tables, both backend interfaces with default pgvector implementations. `write()` and `upsertPage()` wired from `heartbeat.ts` (entries) and the reflection worker (pages, in phase 3).
2. **Recall + retrieval-augmentation.** `recall()` for facts, `recallPages()` for pages with link expansion. Prompt-prefix `<memory>` and `<wiki>` injection.
3. **Reflection worker — Ingest pipeline.** Episodic → semantic → page upsert. No lint yet.
4. **Reflection worker — Lint pipeline.** Daily lint pass; revision chain for pages.
5. **Decay + soft-delete.** Salience decay for both entries and pages.
6. **MCP server adapter.** External agents read/write paperclip memory + wiki.
7. **Plugin backend.** `MemoryBackend` and `WikiBackend` plugin interfaces; reference implementations pointing at Mem0 (facts) and an external Markdown source (pages).
8. **Admin UI + observability.** `/admin/memory`, page browser with revision diff view, metrics, OTel spans.

Phases 1-4 deliver a usable wiki-shaped memory; 5-8 are quality-of-life and interop.

## Risks

- **Embedding cost.** A company with 100k episodic entries embedded at voyage-3-large pricing is ~$5 in one-time embedding cost; not crippling but should be visible in the budget UI. Mitigation: opt-in salience filter — don't embed entries below a threshold.
- **Reflection cost.** LLM calls per entry add up. Mitigation: batch extraction (one prompt for N entries), per-company budget cap, configurable disable. Lint is bounded at one call per page per day.
- **Lint regressions.** A bad lint pass writes a worse page than the prior revision. Mitigation: parent_id chain preserves history; admin UI shows revision diffs and allows rollback; the `lint_notes` column captures the LLM's rationale so a regression is debuggable.
- **Hallucinated semantic facts → bad pages.** LLMs extract "facts" that aren't real; the page assembly amplifies them. Mitigation: every semantic entry carries `source_run_id`; the page carries `source_entry_ids`; admin UI shows the chain; supersession lets corrections propagate through lint.
- **Memory drift / staleness.** Old facts contradict new reality. Mitigation: lint surfaces contradictions; `lint_status = 'contradicted'` is an actionable signal.
- **Wiki size growth.** Companies with many issues might accumulate hundreds of pages. Mitigation: page-level decay; lint can mark `needs_split` for pages that grew too long; admin UI shows page count + size by scope.
- **PII / secrets capture.** Memory might pick up API keys or PII from logs. Mitigation: an opt-in PII-redaction step in reflection (regex + LLM-based scrubber).

## Decisions following review (2026-05-13)

- **Adopt the Karpathy three-layer model** (raw / wiki / schema) rather than fact-per-row alone. Pages are a first-class table, not a view over entries. The wiki layer compounds where vector chunking can't.
- Default embedding: **voyage-3-large** at 1024-dim with int8 quantization. Override per-company via plugin.
- Default backends: **pgvector + HNSW for both facts and pages**. Mem0/Zep/Letta as plugin-provided alternates for facts; external markdown sources (filesystem, Notion, MediaWiki) plausible plugin alternates for pages.
- Scope hierarchy: user > company > agent > session for the recall ranker.
- Reflection: **background worker**, not in-loop. Reconsider in v2.
- Memory writes are first-class on every run event. Page upsert is reflection-driven; agents can also `upsertPage` explicitly via the in-run tool.
- **Lint as a named operation.** Distinct from extraction. Daily cadence default; configurable per-company.

## Notes on deferred concerns

- **Graph memory.** Zep/Graphiti's bi-temporal model is the right answer for "X was true between T1 and T2." Punted to a plugin because Neo4j is a heavy dep for the OSS path. Note: paperclip's `memory_page_links` is *page-level* graph, not the *fact-level* temporal graph Zep ships.
- **Procedural memory cross-agent transfer.** v1 keeps procedural memory at agent scope. Operator promotion to company scope is the manual mechanism. Automatic cross-agent transfer requires a similarity model we don't have yet.
- **In-loop memory paging (Letta).** Requires the adapter to call `recall_memory` mid-generation, which means the adapter must speak the contract. The MCP tool surface in Phase 3 of the workers spec is the right hook; v1 ships it but doesn't require adapters to use it.
- **Multi-author collaborative editing of pages.** No CRDT; concurrent `upsertPage` calls use last-write-wins via `parent_id`. Multi-agent shared scratchpads are deferred.
- **Wiki export / import.** Companies will eventually want to move wikis between deployments. v1 can SELECT the rows; a structured export/import format is a follow-up.
- **Bidirectional sync to external wikis.** Notion / Confluence / MediaWiki integrations stay out of scope; if needed, a plugin layered on `WikiBackend` is the entry point.

## Open questions

1. **Default embedding model.** voyage-3-large is the 2026 leader on retrieval quality, but adds a non-OpenAI dep. Should the OSS default be OpenAI text-embedding-3-large for fewer accounts, with voyage as the recommended upgrade?
2. **Memory writes on every run event vs sampling.** A high-volume routine that runs every minute would write 1.4k episodic entries/day. Should we sample, or rely on decay + reflection consolidation to keep the working set small?
3. **Page slug naming convention.** Karpathy's gist leaves this to `schema.md`. Should paperclip ship a default convention (kebab-case nouns: `auth-middleware`, `deployment-process`), require companies to define one, or let the LLM pick?
4. **Lint scope.** Per-page or per-page-with-context (linked pages)? The latter is more expensive but catches inter-page contradictions. Default per-page; per-page-with-context as opt-in.
5. **Page promotion across scopes.** When an agent-scoped page proves useful across agents, should the operator promote it to company scope? Manual button vs automatic threshold (recalled by N agents)?
6. **MCP server auth.** When external agents read paperclip memory + wiki via MCP, what's the auth boundary? Per-agent token? Per-company shared secret?
7. **Backwards-compat with `AGENTS.md` / `SKILL.md`.** Should hand-authored `AGENTS.md` content be auto-imported as company-scoped wiki pages at boot? Or stay parallel?
8. **Page size cap.** A page that grows past N tokens loses retrieval precision. Should the `needs_split` lint signal be auto-acted-on (ask the LLM to split) or operator-acted-on?

---

*Draft: 2026-05-13, revised 2026-05-14 to incorporate the Karpathy LLM-Wiki pattern. Review with: spec author + ops lead + security review for tenant isolation. Plan document follows once the open questions resolve.*
