# Automatic Organizational Learning Design

> Spec for the **Automatic Organizational Learning** roadmap milestone. Grounded in the May 2026 state-of-the-art (Anthropic's reflection-loop research, Devin's playbook surface, Cursor's "rules of the codebase" / .cursor/rules pattern, organizational-knowledge-graph systems like Mem0 + Letta + LangChain LCEL, MCP Resources). Plan document follows once the open questions resolve.

## Problem

Paperclip already captures everything that happens — runs, comments, decisions, artifacts, plans — across Memory (Plan 1), Artifacts (Plan 1), Work Queues (Plan 1), and Deep Planning (Plan 1). The reflection worker even promotes episodic facts into semantic facts and curated wiki pages. But there's a gap between **passive capture** and **active reuse**:

- An operator opens an issue "deploy went red on staging again" — the agent has no way to know that the company has fixed this exact pattern 12 times before with the same 3-step recovery.
- A new hire opens "add a feature flag for X" — they have to discover from scratch the company's feature-flag conventions, even though every prior feature-flag plan made the same 5 decisions in the same order.
- An operator is choosing between two agents for a task. There's no profile of what each agent has historically been good at.
- The wiki pages produced by the reflection worker are general-purpose markdown — agents can read them but can't *act on them as procedures*.

The 2026 industry consensus is that organizational learning is its own subsystem on top of capture: structured **playbooks** ("when X, do Y, expecting Z"), **outcome patterns** ("we've solved this category of problem 12 times; common shape is N"), **skill profiles** per agent, and **decision patterns** ("we tend to pick PostgreSQL when… and SQLite when…"). The point is to make prior work *suggest itself* at the moment new work starts, not merely sit in a searchable archive.

## Goals

1. A `playbooks` layer — structured, versioned, applicability-tagged procedures distinct from free-text wiki pages. Agents and humans author / curate / approve them.
2. **Pattern mining** — periodic worker that clusters similar completed issues + their resolutions and proposes new playbooks (or evidence rows on existing playbooks).
3. **Skill mining** — derive a skill profile per agent from run history, completion rates, and technologies touched. Inform the agent-picker UI.
4. **Decision-pattern aggregation** — across `plan_decisions`, surface recurring choice rationales so future plan authors see "here's what we usually pick under these conditions."
5. **Proactive suggestion at issue pickup** — when an agent claims a run, search playbooks + patterns for applicability matches; prepend the top match to the memory prompt-prefix so the agent starts from prior canon.
6. **MCP-Resource exposure** — playbooks + patterns + skill profiles become MCP resources external agents can read (Claude Desktop, Cursor) under per-company auth.
7. **Curation surface** — `/admin/learning` page where operators review proposed playbooks before they're auto-applied, edit patterns, override skill profiles, and inspect the evidence trail.

## Non-goals (v1)

- **Real-time pattern mining.** Mining runs on the same cadence as the reflection worker (default 5 minutes); detecting a pattern in a single run is out of scope.
- **Cross-company federation.** Each company's playbooks + patterns + skills are isolated. A future "industry templates" plugin can layer on top.
- **Adversarial robustness.** Mined patterns are defaults, not gates — they prepend to the prompt, they don't block runs. A misaligned pattern at worst produces a slightly-off suggestion.
- **Auto-execution of playbooks.** The agent reads the playbook + decides whether to apply it. v1 doesn't auto-execute steps without human review for novel issues.
- **Skill scoring across agents.** Per-agent profiles only — we don't rank or compare. Comparing agents requires policy decisions out of scope.
- **Replacing memory wiki pages.** Playbooks are *additional structure on top of* free-text wikis; they don't replace `memory_pages`. The reflection worker still writes wiki pages for general knowledge; playbooks are the procedural-output layer.

## Architecture

```
┌───────────────────────┐
│  capture layers       │
│  (already shipped)    │
│                       │
│  memory_entries       │
│  memory_pages         │
│  artifacts            │
│  plan_decisions       │
│  plan_revisions       │
│  heartbeat_runs       │
│  routines             │
└────────┬──────────────┘
         │
         ▼
┌───────────────────────────────────┐
│  learning workers                 │
│  (extends memory reflection)      │
│                                   │
│  pattern miner ─┐                 │
│                 ├──► playbooks    │
│  skill miner ───┤    outcome_patterns
│                 │    agent_skills │
│  decision-pattern   decision_patterns
│  aggregator ────┘                 │
└────────┬──────────────────────────┘
         │
         ▼
┌───────────────────────────────────┐
│  applicability matcher            │
│  (pure: issue context + playbook  │
│   conditions → relevance score)   │
└────────┬──────────────────────────┘
         │
         ├──► heartbeat: prompt-prefix ─► agent run
         ├──► UI: agent picker (skill profile)
         ├──► UI: /admin/learning (curation)
         └──► MCP server: paperclip://learning/...
```

### Schema

```sql
-- Playbooks: versioned, procedural. content_markdown is the body
-- (steps + acceptance criteria); applicability_conditions is a
-- JSONB filter shape the matcher evaluates against issue context.
CREATE TABLE playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    -- agent-scoped playbooks (a specific agent's runbook) + null
    -- means company-wide.
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
    -- kebab-case; unique within (company_id, agent_id?, status='active')
  status TEXT NOT NULL DEFAULT 'proposed',
    -- 'proposed' (mined, awaiting curation)
    -- | 'active'   (operator approved, agents see it)
    -- | 'archived' (operator removed)
    -- | 'superseded' (replaced by a newer playbook)
  current_revision_id UUID,
  current_revision_number INT NOT NULL DEFAULT 1,
  applicability_conditions JSONB,
    -- {"issue_keywords": [...], "labels": [...], "project_id": ...,
    --  "agent_role": ..., "min_confidence": 0.6}
  source_run_ids UUID[],
    -- Evidence: runs whose resolutions informed this playbook.
  source_plan_ids UUID[],
    -- Plans that contributed (often via plan_decisions).
  confidence REAL NOT NULL DEFAULT 0.5,
    -- 0..1. Mined playbooks start lower; manual edit can pin to 1.0.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);
CREATE INDEX playbooks_company_status_idx ON playbooks (company_id, status);
CREATE INDEX playbooks_agent_idx ON playbooks (agent_id);

-- Snapshot+parent revision chain. Same shape as memory_pages /
-- plan_revisions. The reflection worker can propose new revisions
-- on existing playbooks when new evidence accumulates.
CREATE TABLE playbook_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_id UUID NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  parent_revision_id UUID REFERENCES playbook_revisions(id) ON DELETE SET NULL,
  content_markdown TEXT NOT NULL,
  change_summary TEXT,
  created_by_user_id TEXT,
  created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (playbook_id, revision_number)
);

-- Outcome patterns: mined clusters of similar resolutions. A
-- pattern can be "promoted" to a playbook when an operator
-- approves it.
CREATE TABLE outcome_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pattern_name TEXT NOT NULL,
  pattern_description TEXT,
  exemplar_run_ids UUID[] NOT NULL,
    -- Top-N representative runs (default 5).
  cluster_size INT NOT NULL,
    -- Total runs identified as in this cluster.
  derived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence REAL NOT NULL DEFAULT 0.5,
  promoted_to_playbook_id UUID REFERENCES playbooks(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ
);
CREATE INDEX outcome_patterns_company_idx ON outcome_patterns (company_id, derived_at DESC);

-- Agent skills: derived profile per agent. last_evidenced_at and
-- confidence let the UI show "still actively practicing" vs
-- "historical strength."
CREATE TABLE agent_skills (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
    -- Free-form: "typescript-refactor", "postgres-migration",
    --   "incident-response", etc. Curatable.
  evidence_run_ids UUID[] NOT NULL,
  last_evidenced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence REAL NOT NULL DEFAULT 0.5,
  derived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, skill_name)
);
CREATE INDEX agent_skills_company_idx ON agent_skills (company_id);

-- Decision patterns: aggregated across plan_decisions. "We tend to
-- pick X when [conditions]". The aggregator hashes the condition
-- summary so re-runs collapse onto the same row.
CREATE TABLE decision_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  condition_summary TEXT NOT NULL,
    -- "When choosing a database for analytics workloads"
  typical_choice TEXT NOT NULL,
    -- "PostgreSQL"
  exemplar_decision_ids UUID[] NOT NULL,
  cluster_size INT NOT NULL,
  derived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence REAL NOT NULL DEFAULT 0.5,
  superseded_at TIMESTAMPTZ,
  superseded_by_id UUID REFERENCES decision_patterns(id) ON DELETE SET NULL
);
CREATE INDEX decision_patterns_company_idx ON decision_patterns (company_id);
```

### Service contract

```ts
interface OrgLearningService {
  // Playbooks
  createPlaybook(ctx, input): Promise<Playbook>;
  reviseplaybook(ctx, id, input): Promise<PlaybookRevision>;
  approvePlaybook(ctx, id): Promise<void>;
  archivePlaybook(ctx, id): Promise<void>;
  listPlaybooks(ctx, filter): Promise<Playbook[]>;

  // Patterns + skills (read mostly; write via miners)
  listOutcomePatterns(ctx): Promise<OutcomePattern[]>;
  promotePatternToPlaybook(ctx, patternId): Promise<Playbook>;
  listAgentSkills(ctx, agentId): Promise<AgentSkill[]>;
  listDecisionPatterns(ctx): Promise<DecisionPattern[]>;

  // Suggestion (hot path)
  suggestPlaybooks(ctx, issueContext): Promise<Array<{
    playbook: Playbook;
    score: number;
    matchReason: string;
  }>>;
}
```

### Pattern miner

Runs on the existing reflection-worker cadence (5min default). Pure inputs are clusters of recently-completed runs; the miner:

1. Pulls runs that finished in the past N hours (default 24).
2. Groups by issue similarity — embedding-distance clustering on (issue_title + agent's run summary). Reuses the same embedding provider that powers Memory (Plan 1).
3. For clusters of size ≥ MIN_CLUSTER (default 3), calls the LLM to synthesize a `pattern_name` + `pattern_description` + 5 exemplar run ids.
4. Inserts an `outcome_patterns` row at confidence = `min(0.9, cluster_size / 10)`.
5. Existing pattern with similar `pattern_name` (cosine on description embedding) accumulates evidence: cluster_size += new_runs, exemplar_run_ids extended, confidence updated.

A pattern doesn't auto-create a playbook. The operator (or a planner-agent in Plan 2) calls `promotePatternToPlaybook` when ready; the API takes the pattern's exemplars + asks the LLM to draft a procedural playbook body.

### Skill miner

Same cadence. Per agent, examines runs over the past 30 days:

1. Extract topics + technologies touched per run via lightweight LLM tagging on the run's summary + issue title.
2. Aggregate per (agent_id, skill_name): count of runs touching that skill, last_evidenced_at = MAX(finished_at).
3. Skill confidence = `min(0.95, runs_count / 20)`.
4. Decay: skills with last_evidenced_at older than 90 days drop confidence by 0.1 per month.

The agent picker reads `agent_skills` to surface "this agent is good at X" hints; routes still expose the underlying data so plugins can build alternative pickers.

### Decision-pattern aggregator

For each `plan_decision`, the aggregator computes a content hash on `(title, options, rationale)` (after normalization). Decisions with similar hashes cluster; the LLM synthesizes a `condition_summary` + `typical_choice`. Confidence scales with cluster size.

The plan UI's review surface (Deep Planning Plan 1) reads `decision_patterns` filtered to similar phases so reviewers see "we usually pick X when…" inline.

### Applicability matcher

Pure function `matchPlaybookApplicability(issueContext, playbook)`:

```ts
type IssueContext = {
  title: string;
  body?: string;
  labels: string[];
  projectId?: string;
  assigneeAgentId?: string;
  // If we already have an embedding (recall provider populated),
  // pass it; otherwise the matcher computes a quick TF-IDF score.
  titleEmbedding?: Float32Array;
};

function matchPlaybookApplicability(
  ctx: IssueContext,
  playbook: Playbook
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  const conditions = playbook.applicability_conditions ?? {};

  // Keyword match on title.
  if (conditions.issue_keywords?.length) {
    const hits = conditions.issue_keywords.filter(k =>
      ctx.title.toLowerCase().includes(k.toLowerCase())
    );
    score += hits.length * 0.2;
    if (hits.length) reasons.push(`keywords: ${hits.join(', ')}`);
  }
  // Label match.
  if (conditions.labels?.length) {
    const hits = conditions.labels.filter(l => ctx.labels.includes(l));
    score += hits.length * 0.3;
  }
  // Project scope.
  if (conditions.project_id && ctx.projectId === conditions.project_id) {
    score += 0.5;
  }
  // Agent role / id.
  if (playbook.agent_id && playbook.agent_id === ctx.assigneeAgentId) {
    score += 0.4;
  }
  // Confidence weight.
  score *= playbook.confidence;
  return { score: Math.min(1, score), reason: reasons.join('; ') };
}
```

The heartbeat hook calls `suggestPlaybooks` with the issue context just before the run begins and prepends the top-1 (or top-3 if score > 0.3) playbook bodies to the existing `<memory>` prompt-prefix.

### Lifecycle

```
[mined]            [authored / curated]
  │                  │
  ▼                  ▼
proposed ─────► active ─────► archived
  │              │
  │              ├─► superseded (new revision activates)
  ▼
discarded
```

Mined playbooks land in `proposed` and surface in `/admin/learning`. Operators review + approve to move to `active`. Archived playbooks stay queryable but don't suggest. Superseded happens when a new revision is approved on an existing slug.

### MCP-Resource integration

The MCP server (Memory Plan 2 ships the protocol surface; this plan extends it):

```
paperclip://learning/playbooks/<company-slug>/<slug>
paperclip://learning/patterns/<company-slug>/<id>
paperclip://learning/skills/<agent-id>
paperclip://learning/decisions/<company-slug>
```

External agents (Claude Desktop, Cursor) can `resources/list` and `resources/read` against these. Playbook + pattern reads are gated by company access; skill reads expose the agent's profile to its own company.

## Observability

OTel spans:
- `paperclip.learning.pattern.mine` (children: cluster + llm-synthesize spans)
- `paperclip.learning.skill.mine`
- `paperclip.learning.decision_pattern.aggregate`
- `paperclip.learning.suggest` (issue-pickup hot path)
- `paperclip.learning.playbook.{create,revise,approve,archive}`

Metrics:
- `paperclip_playbooks_active{company,status}` — gauge
- `paperclip_outcome_patterns_total{company}` — counter
- `paperclip_agent_skills_total{company}` — counter
- `paperclip_learning_suggest_latency_ms` — histogram
- `paperclip_learning_suggest_match_score` — histogram (helps tune the threshold)
- `paperclip_learning_pattern_promotion_total` — counter (proposed → active)

## Failure modes

| Failure | Behavior |
|---|---|
| Pattern miner LLM call fails | Logged; the miner skips that batch and retries next tick. No DB writes from a failed mine. |
| Two miners race on the same cluster | Cluster identity is content-hash-based; the second miner sees the first row and updates evidence rather than inserting a duplicate. |
| Embedding provider unavailable | Pattern miner falls back to TF-IDF clustering at lower precision; logged warning; admin UI surfaces "degraded clustering" banner. |
| Agent skill confidence drift | Decay is per-month; bug in tagging that adds spurious skills decays out within ~6 months. Operator can manually delete via admin UI. |
| Wrong playbook suggested | Cost is one suggestion; agent ignores it. Logged via the suggest_match_score histogram so operators see false-positives. |
| Playbook revision conflict | partial-unique on (company_id, agent_id?, slug) WHERE status='active' — concurrent inserts surface as 409. |

## Phasing

1. **Schema + service contract.** All four tables + the playbook revision chain.
2. **Playbook CRUD + revision chain.** Manual authoring path.
3. **Applicability matcher.** Pure helper.
4. **Pattern miner: pure clustering.** TF-IDF and embedding-based.
5. **Pattern miner: production wire.** Extends the existing reflection-worker module.
6. **Skill miner.** Same cadence, separate stage.
7. **Decision-pattern aggregator.** Same cadence.
8. **Suggestion: heartbeat hook + prompt-prefix injection.**
9. **REST endpoints.**
10. **UI: /admin/learning curation surface.**
11. **UI: agent skills page.**
12. **UI: pattern dashboard.**
13. **MCP-Resource exposure.** (Lands when Memory Plan 2's MCP server is in master.)
14. **OTel spans + metrics.**

Phases 1–8 deliver active learning; 9–14 are quality-of-life and interop.

## Risks

- **LLM cost.** Pattern + skill mining over many runs adds LLM calls. Mitigation: per-tick budget cap (env var `LEARNING_MAX_LLM_CALLS_PER_TICK`); admin UI shows token/cost projection.
- **Suggestion noise.** Low-confidence playbooks suggested too eagerly tank recall quality. Mitigation: configurable score threshold (default 0.3); per-suggest histogram for tuning.
- **Privacy.** Cross-issue clustering may surface internal info inappropriately if MCP is opened to outside agents. Mitigation: MCP gated per company; skill reads scoped to the agent's own company.
- **Skill staleness.** Agents who pivot stop matching their old skills. Mitigation: 90-day decay + manual override + UI surface for "skills falling off."
- **Pattern instability.** A miner that re-clusters every tick produces unstable patterns. Mitigation: cluster identity is content-hash + cluster-size-monotone-update; the same cluster doesn't re-spawn under a new id.

## Decisions

- **Playbooks as a separate table from memory_pages.** Pages are general-purpose markdown; playbooks have applicability_conditions + status lifecycle. Different shapes, different surfaces.
- **Pattern miner extends reflection worker.** Same cadence, same DB transaction boundary as M-12+. Avoids a second scheduler loop.
- **Skill profile is per-agent + free-form skill_name.** Trying to enumerate a fixed taxonomy is brittle; let the LLM tag freely + curate via the admin UI.
- **Suggestion is read-only via prompt-prefix.** The agent decides; v1 doesn't auto-apply playbooks.
- **MCP resources from day 1 (read).** Build as if external agents will consume; gates the per-company auth surface up front.

## Notes on deferred concerns

- **Auto-execution of playbooks.** Plan 2 — once Enforced Outcomes lands and we have stronger acceptance criteria.
- **Cross-company industry templates.** A separate plugin surface; out of scope for this plan.
- **Skill scoring/ranking across agents.** Out of scope.
- **Adaptive scheduling based on skill match.** A future "agent picker" upgrade — uses skill profiles to suggest the best agent for an issue.

## Open questions

1. **Default suggestion threshold.** 0.3 vs 0.5? Lower means more suggestions (potentially noisy); higher means missed relevant ones. Configurable per company.
2. **Pattern → playbook promotion.** Auto-promote at confidence ≥ 0.8, or always require operator approval? v1 default to require approval.
3. **Skill name canonicalization.** Free-form is brittle ("typescript-refactor" vs "ts-refactor"). Should the miner consult an existing skill list and prefer matches? Probably yes — bias toward existing names.
4. **Playbook scope.** company-wide vs agent-scoped. Both supported in schema; UI defaults?
5. **Pattern miner age window.** 24h is responsive but small clusters; 7d is more stable but slower to surface new patterns. Default + override per company.

---

*Draft: 2026-05-15. Review with: spec author + product lead + ML reviewer for the clustering details. Plan document follows.*
