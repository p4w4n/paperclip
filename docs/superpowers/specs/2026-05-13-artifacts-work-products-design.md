# Artifacts + Work Products Design

> Spec for the **Artifacts & Work Products** roadmap milestone. Grounded in the May 2026 state-of-the-art (Claude Artifacts, Bolt's ActionRunner, Cursor Composer 2, e2b sandboxes, Cloudflare Dynamic Workers, MCP Resources, OCI Artifacts for AI). See `docs/research/2026-05-13-artifacts-research-brief.md` for the underlying research.

## Problem

Paperclip agents produce output across four scattered concepts today:

- `heartbeat_runs.summary` — a free-text blurb about what the run did.
- `document_revisions` — versioned text/markdown documents the agent edited or wrote.
- `issue_work_products` — a thin polymorphic table linking runs to "things produced."
- `execution_workspaces` + the realized cwd on the worker — the actual files the agent wrote.

There's no unified concept of "this run produced these typed outputs at these versions, with these previews, ready for a human to review or merge or deploy." Operators piece it together from the issue thread, run logs, and (for code) the workspace directory after the fact. Reviewers can't tell at a glance "the agent shipped a PDF report, two source files, and a deployable web preview" without reading the run.

This is the gap that the 2026 industry has filled with **typed artifacts**: Claude's artifact pane, Bolt's ActionRunner, Cursor Composer 2's multi-file diff review, Devin's PR-as-output, e2b's preview-URL-per-sandbox. Paperclip needs the same primitive.

## Goals

1. A unified **artifacts** layer that polymorphically attaches to `(run_id, issue_id)`, replacing or wrapping `issue_work_products` as the canonical "this run made this thing" record.
2. **Typed kinds** with a JSON-schema per kind: `code.file`, `code.patch`, `doc.markdown`, `doc.office`, `web.app`, `chart`, `data.table`. Extensible via plugin.
3. **Content-addressed blobs** so the same artifact across runs deduplicates; storage backend is the existing `storage/` provider abstraction (local-disk / S3 / GCS landed in workers Phase 5).
4. **Versioning** by snapshot + parent pointer (matches existing `document_revisions` semantics). Diffs are derived lazily.
5. **Preview hosting** via a pluggable provider — local execution_workspace for dev, e2b microVM or Cloudflare Sandbox for hosted. Each preview is a TTL'd ephemeral URL.
6. **MCP Resource** view: paperclip exposes artifacts as MCP resources so external agents (Claude Desktop, Cursor) can consume them.
7. **Agent declaration** via a typed tool call: agents call `declare_artifact(kind, content_uri, schema)` and the server materializes the row + blob.

## Non-goals (v1)

- **Live / data-bound artifacts** (Claude's April-2026 Live Artifacts, dashboards that re-evaluate against bound data). Useful for analytics but a separate concern; punted to a plugin.
- **CRDT collaborative editing.** Mainstream agent stacks have not adopted this; v1 sticks with snapshot-per-revision.
- **Full git-style operational history.** We do not aim to be a git replacement. Code patches map to git via the existing workspace; non-code artifacts get snapshot+parent.
- **Cross-tenant artifact federation.** Each company's artifacts are isolated.
- **Binary diffs.** Non-text artifacts get content-addressed snapshots only. Diffing is text-only in v1.
- **Persistent preview URLs.** Previews are ephemeral by design (TTL'd sandbox). Promotion to a durable URL is a separate concern (deploy pipeline, not artifact storage).

## Architecture

```
┌─────────────────────────┐                  ┌──────────────────────┐
│   agent run on worker   │                  │   control plane      │
│                         │                  │                      │
│  declare_artifact(kind, │ ───gRPC frame──► │   artifacts service  │
│    content_uri, schema) │                  │  ┌────────────────┐  │
│                         │                  │  │  artifacts row │  │
│                         │                  │  │  (manifest)    │  │
└─────────────────────────┘                  │  └────────┬───────┘  │
                                             │           │          │
                                             │  ┌────────▼───────┐  │
                                             │  │ artifact_blobs │  │
                                             │  │ (content-addr) │  │
                                             │  └────────────────┘  │
                                             │           │          │
                                             │  ┌────────▼───────┐  │
                                             │  │ Storage prov.  │  │
                                             │  │ (local/S3/GCS) │  │
                                             │  └────────────────┘  │
                                             │                      │
                                             │  ┌────────────────┐  │
                                             │  │ MCP-Resource   │  │
                                             │  │ adapter        │  │
                                             │  └────────────────┘  │
                                             └──────────────────────┘
                                                       ▲
                                                       │
                                                ┌──────┴──────┐
                                                │ Preview     │
                                                │ provider    │
                                                │ (e2b/CF/    │
                                                │  local)     │
                                                └─────────────┘
```

### Schema

```sql
-- The manifest. One row per artifact-revision. Per-kind JSON Schema
-- validates `content_meta`. Reuses Plan 1 distributed-workers
-- worker_session_id semantics — every artifact is provenanced.
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Polymorphic on (run, issue). Both are nullable so a manually
  -- uploaded artifact (operator action) doesn't need a fake run.
  run_id   UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  issue_id UUID REFERENCES issues(id)         ON DELETE SET NULL,
  -- Typed kind. Kind values are kept in a constants list shared with
  -- @paperclipai/shared so server + UI + adapters agree.
  kind     TEXT NOT NULL,         -- 'code.file' | 'code.patch' | 'doc.markdown' | ...
  -- Logical name within the issue/run scope. For code.file kinds this
  -- is the path ("src/foo.ts"); for doc kinds a slug; for web.app a label.
  name     TEXT NOT NULL,
  -- Content addressing. blob_sha256 is the digest of the canonical
  -- representation; same digest across runs = same blob row, only
  -- the manifest is duplicated (cheap).
  blob_sha256 TEXT NOT NULL,
  blob_bytes  BIGINT NOT NULL,
  blob_storage_provider TEXT NOT NULL,  -- 'local_disk' | 's3' | 'gcs'
  blob_storage_key      TEXT NOT NULL,
  content_type          TEXT NOT NULL,  -- MIME-ish; e.g. 'application/json'
  -- Per-kind structured metadata, validated against the kind's schema.
  -- e.g. for code.patch: {"target_ref": "main", "files_changed": 3}
  content_meta JSONB,
  -- Versioning. parent_id points at the previous revision (same name,
  -- same scope). Diffs derived on demand.
  parent_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  -- Preview. Resolved by the preview provider; null when not previewable
  -- or expired.
  preview_url TEXT,
  preview_expires_at TIMESTAMPTZ,
  preview_provider   TEXT,  -- 'e2b' | 'cloudflare' | 'local' | NULL
  -- Lifecycle.
  declared_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  declared_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  superseded_at TIMESTAMPTZ,
  superseded_by_id UUID REFERENCES artifacts(id) ON DELETE SET NULL
);

CREATE INDEX artifacts_run_idx           ON artifacts (run_id);
CREATE INDEX artifacts_issue_idx         ON artifacts (issue_id);
CREATE INDEX artifacts_company_kind_idx  ON artifacts (company_id, kind);
CREATE INDEX artifacts_name_scope_idx    ON artifacts (issue_id, name) WHERE superseded_at IS NULL;
CREATE INDEX artifacts_sha_idx           ON artifacts (blob_sha256);
```

A separate `artifact_blobs` table is *not* needed initially — content-addressing dedupes at the storage-key level (multiple manifest rows with the same `blob_storage_key`). If lifecycle of blob storage diverges from manifests we add it later.

### Artifact kinds (v1 set)

| Kind | content_type | Notes |
|---|---|---|
| `code.file` | text/* mostly | Full file snapshot. Path lives in `name`. |
| `code.patch` | text/x-diff | Unified diff against `content_meta.target_ref`. |
| `doc.markdown` | text/markdown | Reuses `document_revisions` table for content (manifest references it). |
| `doc.office` | application/vnd.openxmlformats-* | Word/Excel/PowerPoint. Binary blob. |
| `chart` | image/svg+xml or application/json (vega-lite) | Data viz output. |
| `data.table` | text/csv or application/json | Tabular data. |
| `web.app` | application/zip | Deployable bundle; preview-provider deploys it. |

JSON Schemas for each kind live in `packages/shared/src/artifact-kinds/`. Plugins register additional kinds via the same registry.

### Agent declaration contract

Agents declare artifacts via a typed proto frame on the existing distributed-workers gRPC stream — extends `WorkerToServer.payload` with one new variant.

```proto
// (additive on top of Plan 1 distributed-workers proto)
message ArtifactDeclared {
  string run_id = 1;
  string kind = 2;
  string name = 3;
  string content_type = 4;
  bytes  content_meta_json = 5;     // per-kind structured meta
  // Either inline (small) or a worker-uploaded blob URI. Workers upload
  // large artifacts to the storage provider via signed URL (the same
  // mechanism Plan 5 used for session blobs).
  bytes  inline_bytes = 6;
  string blob_uri = 7;              // when set, server fetches + stores
  // Optional preview. When set, the preview provider materializes a
  // sandbox/URL after the manifest row is committed.
  bool   request_preview = 8;
}
```

The control plane's connect-handler routes `ArtifactDeclared` frames to the artifacts service, which:

1. Resolves `blob_sha256` (computes if inline, fetches header if blob_uri).
2. Inserts the manifest row.
3. If `request_preview`, kicks off a preview-provider job (async).
4. Looks up the most recent same-`(issue_id, name)` row → sets `parent_id` if present.

Existing in-process adapters (claude_local, gemini_local) get a thin TS wrapper that calls the same service directly without going through gRPC.

### Preview provider plugin

```ts
interface PreviewProvider {
  id: string;  // 'e2b' | 'cloudflare' | 'local'
  // Materialize a preview for the given artifact. Returns the URL +
  // expiry. The provider is responsible for cleanup at expiry.
  materialize(input: {
    artifactId: string;
    blobStorageKey: string;
    kind: string;
    contentType: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  // Optional: explicit teardown (called on supersede).
  teardown?(input: { artifactId: string }): Promise<void>;
}
```

Default: `local` provider serves preview at `<paperclip>/preview/<artifact_id>/` from the control plane (works for static HTML, markdown render, image, json table). e2b and Cloudflare Sandbox providers ship as plugins.

### MCP-Resource adapter

Each artifact gets a stable URI:

```
paperclip://artifacts/<company-slug>/<issue-id>/<artifact-id>
```

The built-in MCP server (added in Memory spec) exposes these as resources. External agents can list (`resources/list`) and read (`resources/read`). Writes go through a separate MCP tool (`declare_artifact`) so the resource surface stays read-only per the MCP 2025-11-25 spec.

## Lifecycle and states

```
[agent declares artifact]
        │
        ▼
[control plane: write manifest, dedupe blob via sha]
        │
        ├── parent lookup: same (issue, name) → set parent_id
        ├── if request_preview → enqueue provider job
        ▼
[preview provider materializes]
        │
        ▼
[manifest.preview_url set; UI shows live link]
        │
   (TTL passes)
        ▼
[preview_expires_at < now → UI hides URL; manifest persists]
        │
   (newer revision lands)
        ▼
[old manifest.superseded_by_id = new.id; superseded_at = now]
```

## Observability

- New OTel spans: `paperclip.artifact.declare`, `paperclip.artifact.preview.materialize`, `paperclip.artifact.preview.teardown`.
- Metrics: `paperclip_artifacts_declared_total{kind}`, `paperclip_artifact_blob_bytes_total{provider}`, `paperclip_artifact_preview_active_count`, `paperclip_artifact_preview_materialize_latency_ms`.
- UI: each issue's "Work Products" tab shows the artifact list (kind icon, name, declared-by-run, preview link if live, parent diff if applicable). Reuses existing inbox surface.

## Failure modes

| Failure | Behavior |
|---|---|
| Storage provider unreachable on declare | `ArtifactDeclared` frame returns failed; agent retries (idempotent — sha-based dedupe means duplicate declares are no-ops) |
| Preview provider down | Manifest commits cleanly; preview job stays queued; `preview_url` null, UI shows "preview pending"; reaper retries |
| Blob hash mismatch (corruption) | Read fails loudly; artifact marked `corrupted=true` (new column); operator alerted |
| Same `(issue_id, name)` declared concurrently | Postgres `INSERT … RETURNING` resolves; second insert sees the first as parent and chains |
| Preview sandbox never gets cleaned up | `preview_expires_at` reaper sweeps on a 5-minute interval, calls `teardown` on the provider |
| Storage cost runaway (orphan blobs) | Periodic GC pass: any `blob_storage_key` not referenced by a non-superseded manifest within the company's `blob_retention_days` is deleted |

## Phasing

1. **Schema + manifest write path.** `artifacts` table; `declare_artifact` service entry; in-process adapter wrapper. No proto changes yet.
2. **Proto extension + connect-handler routing.** `WorkerToServer.ArtifactDeclared` variant; worker-side helper for declaring from inside the run-handler. Distributed-workers integration.
3. **Per-kind schemas.** JSON Schemas for `code.file`, `code.patch`, `doc.markdown`, `doc.office`. Validated server-side on declare.
4. **UI: Work Products tab.** Renders the manifest list per issue. Reuses existing inbox primitives.
5. **Preview provider abstraction + local provider.** Static HTML / markdown / image rendering from the control plane.
6. **e2b / Cloudflare Sandbox providers.** Plugin packages.
7. **MCP-Resource adapter.** External agents read artifacts.
8. **GC pass for orphan blobs.** Storage-cost containment.

Phases 1-4 deliver a usable artifacts layer; 5-8 are quality-of-life and interop.

## Risks

- **Storage growth.** Code.file artifacts on a hot codebase could blow up fast. Mitigation: content-addressing dedupes; per-company `blob_retention_days` config; GC sweep in Phase 8.
- **Preview-provider security.** Running agent-generated code in a sandbox is the whole point, but mis-configured providers leak. Mitigation: each provider declares its isolation level (`v8-isolate` | `microvm` | `process`); the local provider explicitly refuses `web.app` kinds (don't run untrusted code on the control plane).
- **Schema drift across kinds.** Adding kinds via plugin should not require a core migration. Mitigation: `content_meta JSONB` is opaque to the core; only the per-kind schema (server-side) and the per-kind UI renderer (UI-side) change.
- **MCP resource auth.** External agents reading paperclip artifacts is a sharing boundary. Mitigation: per-company MCP server token; resource access gated by company_id (same as memory in the Memory spec).
- **`issue_work_products` migration.** Existing rows need to lift into the new shape. Mitigation: ship a one-time data migration in the first phase; keep `issue_work_products` as a view over `artifacts` for backwards-compat with any plugin that reads it.

## Decisions following review (2026-05-13)

- **OCI-manifest-style polymorphism:** single `artifacts` table with `kind` + `content_meta JSONB` (not per-kind tables). Easier to query, easier to add kinds via plugin.
- **Snapshot+parent versioning** (not git-style diffs as the source of truth). Diffs derived lazily for the UI.
- **MCP resources** are the cross-vendor read surface; declare goes through a paperclip-native MCP tool (or the gRPC frame, for in-fleet workers).
- **Preview hosting is pluggable from day 1.** Local provider works for static kinds; sandbox providers ship as plugins.
- **Content-addressing via sha256 of canonical bytes.** Same artifact across runs dedupes at the storage layer.

## Notes on deferred concerns

- **Live / data-bound artifacts.** Claude's April-2026 Live Artifacts let dashboards re-evaluate against bound data. Powerful but separable; v1 ships static. A live-artifact plugin can layer on top via a new `kind: 'live.dashboard'` and a server-rendered re-evaluation hook.
- **CRDT collaborative editing.** Cursor Composer 2 doesn't do this, neither does Claude. v1 doesn't either.
- **Binary diff visualizations.** Office docs, charts, images — diffing is hard. v1 shows side-by-side previews of consecutive revisions; per-byte diff is out.
- **Persistent preview URLs.** A separate "deploy" concern. Out of scope here.

## Open questions

1. **Should `document_revisions` become a special case of `artifacts`?** They're conceptually the same shape (snapshot + parent + content). Consolidating reduces the number of "where does the agent's output live?" tables. Risk: existing UI bound to `document_revisions` needs migration.
2. **Per-issue artifact namespace.** If the agent declares two artifacts with the same `name` in different runs, the second supersedes the first. Is this always correct, or should the UI show both ("v1 from run 123, v2 from run 456")? Probably both; the supersede chain is the data model, the UI decision is presentation.
3. **Default preview TTL.** 24h? 7d? Cost vs review window. Configurable per kind probably (web.app gets 24h to keep sandbox costs bounded; doc.markdown gets indefinite since it's static).
4. **Preview-provider plugin interface.** Does it own teardown timing or does the core sweep on a global interval? Probably core sweep — simpler operator story, plugin just declares what to do at teardown.
5. **Authoring tools that produce paperclip artifacts directly.** Should there be a CLI / SDK for declaring artifacts from outside an agent run (e.g., a routine that posts a weekly report)?

---

*Draft: 2026-05-13. Review with: spec author + UI lead + plugin SDK reviewer. Plan document follows once the open questions resolve.*
