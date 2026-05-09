# Memory + Knowledge Design

> Spec for the **Memory / Knowledge** roadmap milestone. Grounded in the May 2026 state-of-the-art (Mem0, Letta, LangMem, Zep/Graphiti, MemoryOS, A-MEM). See `docs/research/2026-05-13-memory-knowledge-research-brief.md` for the underlying research.

## Problem

Paperclip agents are stateless beyond a single run. Each `heartbeat_run` starts cold: the agent re-reads `AGENTS.md`, the issue thread, and any documents the human linked. There is no durable, retrievable memory of *what an agent learned in a prior run*, *what a company has decided in the past*, or *what skills have proven useful for an issue type*. Operators compensate by stuffing prompts with hand-curated context, which scales badly.

Specifically:

- **Per-agent memory.** An agent that fixes a flaky test once should not have to rediscover the cause in the next run on a sibling test. Today the only continuity is the issue's comment thread, which is lossy.
- **Per-company memory.** "We use postgres-js, not pg, in this codebase" is the kind of decision that should be canonical for every agent in the company. Today it lives in `AGENTS.md` files maintained by hand.
- **Per-issue session memory.** A long-running issue with N runs against the same workspace currently re-reads the whole comment thread on each run. Earlier runs' summaries are not consolidated.
- **Cross-issue procedural memory.** "When tests break this way, the fix is usually X" — patterns learned from completed issues should compound.

## Goals

1. Four-scope memory: **user / company / agent / session** (the Mem0-2026 consensus). Reads union-rank across scopes; writes target the most-specific scope where the fact is true.
2. Episodic, semantic, and procedural memory types. Episodic captured automatically (run events, comments); semantic + procedural derived by an async reflection worker.
3. Postgres-native default storage (`pgvector` HNSW) so the existing OSS install gets memory without a new datastore. Pluggable backend so production tenants can swap to Mem0, Zep, or Letta via the existing plugin system.
4. Memory is exposed to agents during a run as a typed tool (`recall`, `write`, `forget`) and via implicit retrieval-augmentation in the prompt-prefix (no tool call required for "remember last 5 facts about this user").
5. MCP server adapter so external agents can read/write paperclip memory; MCP client adapter so paperclip agents can consume external memory backends.
6. GDPR-shaped retention: per-scope TTL + per-user delete; tenant-isolated by company.

## Non-goals (v1)

- **Graph / temporal memory** (Zep/Graphiti's bi-temporal facts). Useful for "X was true until T" reasoning; v1 keeps facts append-only with last-write-wins on conflict. Graph backend lands as an opt-in plugin.
- **Cross-tenant federated memory.** Each company is a hard isolation boundary; v1 has no shared memory pool across companies.
- **Memory-driven agent loop reflection** (Letta-style core/recall/archival paging at the runtime level). Reflection in v1 is a background worker, not an in-loop tool call. Letta-style paging requires an adapter rewrite that we'd rather not couple to v1.
- **Multi-modal memory** (images, audio). Text-only.
- **Real-time multi-agent shared scratchpad.** Two agents working concurrently on the same issue read each other's memory only after a write commits, not via streaming.

## Architecture

```
                    ┌──────────────────────────────┐
                    │  paperclip control plane     │
                    │                              │
                    │  ┌────────────────────────┐  │
                    │  │  memory-service        │  │
                    │  │  recall/write/forget   │  │
                    │  └────────┬───────────────┘  │
                    │           │                  │
                    │  ┌────────▼───────────────┐  │
                    │  │  Backend (default:     │  │
                    │  │  pgvector)             │  │
                    │  │  memory_entries table  │  │
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
                                  ▲
                                  │ async
                    ┌─────────────┴──────────────┐
                    │  reflection-worker         │
                    │  (background; runs on      │
                    │   heartbeat tick +         │
                    │   on-issue-close)          │
                    │                            │
                    │  episodic → semantic       │
                    │  episodic → procedural     │
                    │  consolidation + dedupe    │
                    └────────────────────────────┘
```

### Schema

New tables (one migration):

```sql
-- The base entry. Type-poor on purpose: a JSONB payload + scope keys
-- + content + embedding lets us swap the backend without a schema
-- change. The plugin contract below is what callers depend on.
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scope columns. Exactly one of (agent_id, session_id) may be set;
  -- company_id is always set; user_id is optional (for user-scoped
  -- preferences / facts the human told us).
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID            REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id   UUID            REFERENCES agents(id)     ON DELETE CASCADE,
  session_id UUID,  -- issue_id OR heartbeat_run_id; resolved by `session_kind`
  session_kind TEXT,  -- 'issue' | 'run' | NULL
  -- Memory type.
  kind TEXT NOT NULL,  -- 'episodic' | 'semantic' | 'procedural'
  -- The actual content. JSONB so structured facts ({"prefers": "postgres-js"})
  -- and free-text narratives co-exist.
  content     TEXT  NOT NULL,
  payload     JSONB,  -- optional structured fields (entities, relations)
  -- Embedding for retrieval. Nullable for entries that haven't been
  -- embedded yet (queued in reflection-worker).
  embedding   VECTOR(1024),  -- voyage-3-large default; configurable
  -- Lifecycle.
  source_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  use_count   INT NOT NULL DEFAULT 0,
  -- Salience / decay knobs. Reflection-worker adjusts these.
  salience    REAL NOT NULL DEFAULT 0.5,  -- 0..1; higher = more retrievable
  expires_at  TIMESTAMPTZ,  -- per-scope TTL, null = no expiry
  -- Supersession (last-write-wins on conflict). When this entry is
  -- superseded, supersedes_id points at the new version; reads
  -- skip superseded rows.
  supersedes_id UUID REFERENCES memory_entries(id) ON DELETE SET NULL,
  superseded_at TIMESTAMPTZ
);

CREATE INDEX memory_entries_company_idx ON memory_entries (company_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_agent_idx   ON memory_entries (agent_id)   WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_session_idx ON memory_entries (company_id, session_kind, session_id) WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_user_idx    ON memory_entries (user_id)    WHERE superseded_at IS NULL;
CREATE INDEX memory_entries_embedding_hnsw ON memory_entries
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND superseded_at IS NULL;
```

### Memory service contract

A single in-process service the existing `services/` directory hosts. Plugin authors implement `MemoryBackend` to swap providers (Mem0, Zep, Letta).

```ts
interface MemoryBackend {
  // Write a fact at the most specific scope the caller knows.
  write(input: {
    scope: { companyId: string; userId?: string; agentId?: string;
             sessionId?: string; sessionKind?: 'issue' | 'run' };
    kind: 'episodic' | 'semantic' | 'procedural';
    content: string;
    payload?: Record<string, unknown>;
    sourceRunId?: string;
  }): Promise<{ id: string }>;

  // Recall — union-ranked across scopes the caller has access to.
  // The default ranker weights (user, company) > agent > session, with
  // recency-decay and salience as secondary.
  recall(input: {
    scope: { companyId: string; userId?: string; agentId?: string;
             sessionId?: string; sessionKind?: 'issue' | 'run' };
    query: string;            // semantic search anchor
    limit?: number;           // default 10
    kinds?: Array<'episodic' | 'semantic' | 'procedural'>;
  }): Promise<RecalledEntry[]>;

  // Soft-delete (per GDPR / explicit user signal). The reflection
  // worker will not re-derive a forgotten fact unless its source
  // appears again in episodic memory.
  forget(input: { id: string; reason: 'user' | 'expired' | 'consolidated' }): Promise<void>;
}

interface RecalledEntry {
  id: string;
  kind: 'episodic' | 'semantic' | 'procedural';
  content: string;
  payload?: Record<string, unknown>;
  scope: { kind: 'user' | 'company' | 'agent' | 'session' };
  score: number;  // 0..1; the union-rank score the caller can use
  // Source provenance. UI shows "from issue #123, run abc".
  sourceRunId?: string;
}
```

### Reflection worker

A new periodic job alongside the lease reaper (Plan 2 Task 2 of the workers spec). Consolidates episodic → semantic, mines procedural patterns, and decays salience for unused entries.

- **Tick cadence.** 60 seconds for new-episodic processing; daily for full company-scoped consolidation; on-issue-close for session → agent promotion.
- **Pipeline.**
  1. **Embed pending.** Any `memory_entries` row with `embedding IS NULL` gets an embedding (voyage-3-large default; configurable).
  2. **Extract semantic.** For each new episodic entry, an LLM call produces 0..N candidate semantic facts (`{"prefers": "postgres-js", "for": "this-codebase"}`). De-duplicate against existing semantic memory in the same scope; supersede on conflict.
  3. **Mine procedural.** For closed issues, an LLM call produces an "if-then" skill: "When the failure is X, the fix is Y." Stored at agent scope, optionally promoted to company scope by operator.
  4. **Decay.** `salience` drops by `decay_rate` per day for entries not recalled; entries below `forget_threshold` get soft-deleted.
- **Cost control.** Reflection runs are themselves heartbeat_runs charged to a system agent; per-company budget caps apply. Disabled per-company is a config flag.

### Retrieval-augmentation in run prompts

Two hooks into the existing `executeRun` path in `heartbeat.ts`:

- **Pre-run prompt-prefix injection.** The system prompt gets a `<memory>` block populated by `recall({ scope, query: <issue title + body> })`. Top-K = configurable, default 10.
- **In-run tool calls.** Adapters that support tool calls get `recall_memory(query)` and `remember(content, kind)` exposed via the MCP runtime services from Phase 3 of the workers spec. `recall_memory` is a thin wrapper over the contract above.

### MCP integration

- **Server.** A built-in MCP server exposes `paperclip://memory/<scope>` as MCP resources, plus `recall`/`remember` as MCP tools. External agents (Claude Desktop, Cursor) point at it to read/write paperclip memory.
- **Client.** The plugin system gains a `MemoryBackend` adapter that proxies to an external MCP server. Operators can wire Mem0's MCP server in, and paperclip's `MemoryBackend` calls become MCP tool calls.

## Lifecycle and states

```
[user message / run output]
        │
        ▼
[memory.write episodic]  ──── always synchronous, fast
        │
        ▼
[reflection-worker tick]
        │
        ├── embed if pending
        ├── extract semantic facts
        ├── mine procedural skills (issue close)
        ├── decay unused entries
        ▼
[memory.recall during next run]
        │
        ▼
[salience++, last_used_at = now()]
```

## Observability

- New OTel spans (`paperclip.memory.write`, `paperclip.memory.recall`, `paperclip.memory.reflect`) under the existing `gen_ai.agent.*` semconv.
- Metrics: `paperclip_memory_entries_total{company,kind}`, `paperclip_memory_recall_latency_ms`, `paperclip_memory_reflect_cost_tokens`, `paperclip_memory_decay_evictions_total`.
- Admin UI: `/admin/memory` page surfaces per-company entry counts, top-recalled entries, reflection-worker queue depth.

## Failure modes

| Failure | Behavior |
|---|---|
| pgvector index unavailable / corrupt | Recall falls back to keyword search on `content` (LIKE); slower but doesn't break runs |
| Embedding provider outage | New entries queue with `embedding IS NULL`; reflection-worker drains when provider returns |
| Reflection-worker behind | Episodic still readable; semantic/procedural lag; explicit `paperclip_memory_reflection_lag_seconds` metric pages on |
| External MCP backend (plugin) returns nothing | Adapter falls back to local pgvector; logs `memory_backend_degraded` once |
| Conflicting semantic facts | Last-write-wins via `supersedes_id`; the operator can pin a specific entry as canonical via the admin UI |
| Memory leakage across tenants | All queries are gated on `company_id`; the recall service rejects requests where `company_id` doesn't match the caller's session |

## Phasing

1. **Schema + write path.** `memory_entries` table, `MemoryBackend` interface with the default pgvector implementation. `write()` wires from `heartbeat.ts` on every run event (start, comment, finish).
2. **Recall + retrieval-augmentation.** `recall()` plus the prompt-prefix `<memory>` injection. No reflection yet.
3. **Reflection worker.** Episodic → semantic extraction. Salience + decay.
4. **Procedural memory.** On-issue-close skill mining. Operator promotion to company scope.
5. **MCP server adapter.** External agents can read/write paperclip memory.
6. **Plugin backend.** `MemoryBackend` plugin interface; reference implementation pointing at Mem0's MCP server.
7. **Admin UI + observability.** `/admin/memory`, metrics, OTel spans.

Phases 1-3 deliver a usable memory; 4-7 are quality-of-life and interop.

## Risks

- **Embedding cost.** A company with 100k episodic entries embedded at voyage-3-large pricing is ~$5 in one-time embedding cost; not crippling but should be visible in the budget UI. Mitigation: opt-in salience filter — don't embed entries below a threshold.
- **Reflection cost.** LLM calls per entry add up. Mitigation: batch extraction (one prompt for N entries), per-company budget cap, configurable disable.
- **Hallucinated semantic facts.** LLMs extract "facts" that aren't real. Mitigation: every semantic entry carries `source_run_id`; the admin UI lets operators delete; supersession lets corrections propagate.
- **Memory drift / staleness.** Old facts contradict new reality. Mitigation: bi-temporal validity is *not* in v1 (deferred to graph plugin); v1 relies on supersession + decay. Document this as a known gap.
- **PII / secrets capture.** Memory might pick up API keys or PII from logs. Mitigation: an opt-in PII-redaction step in reflection (regex + LLM-based scrubber).

## Decisions following review (2026-05-13)

- Default embedding: **voyage-3-large** at 1024-dim with int8 quantization. Override per-company via plugin.
- Default backend: **pgvector + HNSW**. Mem0/Zep/Letta as plugin-provided alternates.
- Scope hierarchy: user > company > agent > session for the recall ranker (matches Mem0-2026 default).
- Reflection: **background worker**, not in-loop. Reconsider in v2 once we have data on how often agents would benefit from explicit paging.
- Memory writes are first-class on every run event; we do not require explicit `remember()` tool calls (those are an additive layer).

## Notes on deferred concerns

- **Graph memory.** Zep/Graphiti's bi-temporal model is the right answer for "X was true between T1 and T2." Punted to a plugin because Neo4j is a heavy dep for the OSS path.
- **Procedural memory cross-agent transfer.** v1 keeps procedural memory at agent scope. Operator promotion to company scope is the manual mechanism. Automatic cross-agent transfer requires a similarity model we don't have yet.
- **In-loop memory paging (Letta).** Requires the adapter to call `recall_memory` mid-generation, which means the adapter must speak the contract. The MCP tool surface in Phase 3 of the workers spec is the right hook; v1 ships it but doesn't require adapters to use it.

## Open questions

1. **Default embedding model.** voyage-3-large is the 2026 leader on retrieval quality, but adds a non-OpenAI dep. Should the OSS default be OpenAI text-embedding-3-large for fewer accounts, with voyage as the recommended upgrade?
2. **Memory writes on every run event vs sampling.** A high-volume routine that runs every minute would write 1.4k episodic entries/day. Should we sample, or rely on decay + reflection consolidation to keep the working set small?
3. **Operator visibility into procedural memory.** When the system mines a "skill" from an issue, do we surface it as a notification ("paperclip learned: ...") or only in the admin UI?
4. **MCP server auth.** When external agents read paperclip memory via MCP, what's the auth boundary? Per-agent token? Per-company shared secret?
5. **Backwards-compat with `AGENTS.md` / `SKILL.md`.** Should hand-authored AGENTS.md content be auto-imported as company-scoped semantic memory at boot? Or stay parallel?

---

*Draft: 2026-05-13. Review with: spec author + ops lead + security review for tenant isolation. Plan document follows once the open questions resolve.*
