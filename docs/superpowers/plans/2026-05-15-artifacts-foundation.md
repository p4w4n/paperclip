# Artifacts Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the architectural skeleton from `docs/superpowers/specs/2026-05-13-artifacts-work-products-design.md`. This plan delivers: the unified `artifacts` table with content-addressed blobs, the per-kind JSON Schema registry, the in-process `artifacts-service` write + read paths with tenant isolation, agent declaration via the existing distributed-workers gRPC stream, an in-process adapter wrapper for `claude-local` / `gemini-local`, REST endpoints + the UI Work Products tab, the local preview provider for static kinds, supersession + parent-id chaining, and a back-compat view that keeps `issue_work_products` consumers working during migration.

**Architecture:** New `server/src/services/artifacts/` module owns the manifest service. Storage uses the existing `server/src/storage/` provider abstraction (local-disk / S3 / GCS). The pluggable `PreviewProvider` interface ships with one implementation (`local`) — e2b / Cloudflare are deferred to Plan 2. Agent declaration goes through one of two paths: (1) in-process — `claude-local` / `gemini-local` adapters call the service directly; (2) gRPC — distributed workers send a new `ArtifactDeclared` frame on `WorkerToServer`, the connect-handler routes it into the same service. UI Work Products tab is wired into the existing inbox.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspaces, Vitest, Drizzle ORM (postgres), protobuf-es, @grpc/grpc-js, the existing storage abstraction.

**Scope split (this plan covers Plan 1 of 2 for artifacts):**

- ✅ This plan: schema + content-addressed manifest write path; per-kind JSON Schemas (`code.file`, `code.patch`, `doc.markdown`, `doc.office`, `chart`, `data.table`, `web.app`); service-layer tenant gate; supersession + parent chaining; gRPC frame + connect-handler routing; in-process adapter wrapper; REST list/get endpoints; UI Work Products tab + per-kind renderer; local preview provider for static kinds; one-shot back-compat view over `issue_work_products`.
- ⏭ Plan 2: e2b + Cloudflare preview providers; MCP-Resource adapter for cross-vendor read; orphan-blob GC sweep; `live.dashboard` plugin kind; per-kind preview TTL config; CLI/SDK for declaring artifacts outside an agent run; consolidating `document_revisions` into `artifacts`.

---

## File Structure

**Created:**

- `packages/db/src/schema/artifacts.ts` — Drizzle schema for the manifest table.
- `packages/db/src/migrations/0085_artifacts_foundation.sql` — DDL including the indexes + the back-compat view over `issue_work_products`.
- `packages/shared/src/artifact-kinds/index.ts` — kind registry export.
- `packages/shared/src/artifact-kinds/code-file.ts` — JSON Schema for `code.file`.
- `packages/shared/src/artifact-kinds/code-patch.ts` — JSON Schema for `code.patch`.
- `packages/shared/src/artifact-kinds/doc-markdown.ts` — JSON Schema for `doc.markdown`.
- `packages/shared/src/artifact-kinds/doc-office.ts` — JSON Schema for `doc.office`.
- `packages/shared/src/artifact-kinds/chart.ts` — JSON Schema for `chart`.
- `packages/shared/src/artifact-kinds/data-table.ts` — JSON Schema for `data.table`.
- `packages/shared/src/artifact-kinds/web-app.ts` — JSON Schema for `web.app`.
- `server/src/services/artifacts/types.ts` — `ArtifactsService` contract; `DeclaredArtifact`; `ArtifactKind`; `ArtifactsTenantMismatchError`.
- `server/src/services/artifacts/service.ts` — in-process service: declare / list / get with tenant gate.
- `server/src/services/artifacts/blob-store.ts` — sha256 hasher + storage-provider write helper.
- `server/src/services/artifacts/parent-chain.ts` — pure function: given `(issue_id, name)`, find latest non-superseded row, return new row's parent_id.
- `server/src/services/artifacts/preview/types.ts` — `PreviewProvider` interface.
- `server/src/services/artifacts/preview/local.ts` — local provider (renders static HTML / markdown / image / json table from the control plane).
- `server/src/services/artifacts/preview/registry.ts` — provider registry; resolves `kind` → provider.
- `server/src/services/artifacts/preview/reaper.ts` — pure tick + production wire that calls `teardown` on expired previews.
- `server/src/services/artifacts/__tests__/*.test.ts` — one per file above plus the integration test.
- `server/src/routes/artifacts.ts` — REST endpoints `GET /api/issues/:issueId/artifacts`, `GET /api/artifacts/:id`, `GET /preview/:artifactId/*`.
- `proto/worker/v1/artifacts.proto` — `ArtifactDeclared` message + ack envelope.
- `packages/proto-worker/src/...` — generated bindings (regenerate via existing buf script).
- `packages/worker/src/services/artifacts.ts` — worker-side helper: `declareArtifact({ kind, name, contentBytes | filePath, contentMeta, requestPreview })`.
- `ui/src/features/issues/work-products/WorkProductsTab.tsx` — list view for an issue's artifacts.
- `ui/src/features/issues/work-products/ArtifactRow.tsx` — per-row renderer.
- `ui/src/features/issues/work-products/renderers/index.ts` — per-kind detail renderers.

**Modified:**

- `packages/db/src/schema/index.ts` — re-export `artifacts`.
- `server/src/services/heartbeat.ts` — pre-existing in-process declare path: `claude-local` / `gemini-local` adapters call the artifacts service through a thin wrapper before signaling run completion.
- `server/src/worker-rpc/connect-handler.ts` — route `ArtifactDeclared` frames into the artifacts service.
- `server/src/index.ts` — start the preview reaper alongside the existing reapers.
- `server/src/config.ts` — add `ARTIFACTS_*` env vars (preview-provider-default, preview-default-ttl-hours, preview-reaper-interval-ms).
- `server/src/api-router.ts` — register the new `/api/issues/:issueId/artifacts` + `/api/artifacts/:id` + `/preview/:artifactId/*` routes.
- `ui/src/features/issues/IssueDetail.tsx` — add the Work Products tab to the existing tab list.

**Migration:** `0085_artifacts_foundation.sql`. Adds `artifacts` table + indexes; defines `issue_work_products_legacy` view that exposes the prior table shape over the new schema; keeps `issue_work_products` itself for one release cycle so plugins reading it don't break.

---

## Conventions used in this plan

Same as the memory-foundation and distributed-workers plans:

- **Test framework:** Vitest. Run a single test file with `pnpm --filter <pkg> test <path>`.
- **Build:** `pnpm --filter <pkg> build`. Whole repo: `pnpm -r build`.
- **Type-check only:** `pnpm --filter <pkg> exec tsc --noEmit`.
- **Migrations:** `pnpm --filter @paperclipai/db generate` after editing schema; commit the generated SQL file alongside the schema change. Hand-edit when drizzle-kit's emit is wrong (precedent: 0084 wrapped pgvector + HNSW in DO blocks).
- **Commit style:** conventional commits matching existing history — `feat(server): …`, `feat(db): …`, `feat(ui): …`, `feat(proto): …`, `test(server): …`. Co-author trailer is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **One task per branch off the previous task's branch.** TDD discipline: write failing test → RED → implement → GREEN → typecheck → commit → push.

---

## Task 1: schema + migration

**Files:**

- Create: `packages/db/src/schema/artifacts.ts`
- Create: `packages/db/src/migrations/0085_artifacts_foundation.sql` (run `drizzle-kit generate`, then hand-edit name + index DDL).
- Modify: `packages/db/src/schema/index.ts` — re-export `artifacts`.
- Modify: `packages/db/src/migrations/meta/_journal.json` — rename the auto-named migration tag.

`artifacts` table per the spec's DDL exactly: `id`, `company_id`, `run_id`, `issue_id`, `kind`, `name`, `blob_sha256`, `blob_bytes`, `blob_storage_provider`, `blob_storage_key`, `content_type`, `content_meta` JSONB, `parent_id`, `preview_url`, `preview_expires_at`, `preview_provider`, `declared_at`, `declared_by_agent_id`, `superseded_at`, `superseded_by_id`. Indexes: `artifacts_run_idx`, `artifacts_issue_idx`, `artifacts_company_kind_idx`, `artifacts_name_scope_idx` (partial WHERE `superseded_at IS NULL`), `artifacts_sha_idx`. The partial index gets hand-edited in (drizzle-kit doesn't emit partial-WHERE).

Verify with `pnpm --filter @paperclipai/db test src/client.test.ts` — the migration must apply cleanly on the embedded-postgres test DB.

## Task 2: kind registry + JSON Schemas (shared)

**Files:**

- Create: `packages/shared/src/artifact-kinds/{code-file,code-patch,doc-markdown,doc-office,chart,data-table,web-app}.ts`
- Create: `packages/shared/src/artifact-kinds/index.ts`
- Create: `packages/shared/src/artifact-kinds/__tests__/registry.test.ts`

Each kind module exports `{ id, schema, displayName, contentTypes }`. The `index.ts` exports `ArtifactKindRegistry` — a frozen map id → definition — plus a `validateContentMeta(kind, meta)` helper that runs the schema validator (use `ajv`, already in shared deps if present; otherwise stick with a minimal hand-rolled type-check to avoid the new dep). Test coverage: each kind's schema accepts a known-good shape and rejects a known-bad one.

## Task 3: ArtifactsService contract

**Files:**

- Create: `server/src/services/artifacts/types.ts`
- Create: `server/src/services/artifacts/__tests__/types.test.ts` (only smoke-tests the error class)

`ArtifactsService` interface:

```ts
declare(input: {
  scope: { companyId: string; runId?: string; issueId?: string; agentId?: string };
  kind: string;
  name: string;
  contentBytes?: Uint8Array;
  blobUri?: string;
  contentType: string;
  contentMeta?: Record<string, unknown>;
  requestPreview?: boolean;
}): Promise<{ id: string; superseded: boolean; previewQueued: boolean }>;

list(ctx, { companyId, issueId?, runId? }): Promise<DeclaredArtifact[]>;
get(ctx, { id, companyId }): Promise<DeclaredArtifact | null>;
forget(ctx, { id, companyId, reason }): Promise<void>;
```

Plus `ArtifactsServiceContext` (`callerCompanyId`) and `ArtifactsTenantMismatchError`. Mirrors the `MemoryService` shape.

## Task 4: blob-store helper

**Files:**

- Create: `server/src/services/artifacts/blob-store.ts`
- Create: `server/src/services/artifacts/__tests__/blob-store.test.ts`

`hashAndStore({ bytes, contentType, storageProvider })` computes sha256, derives the storage key (`artifacts/<2-char-prefix>/<sha>`), checks if the key already exists (dedupe), uploads if not. Returns `{ blobSha256, blobBytes, storageKey, alreadyExisted }`. Uses the existing `server/src/storage/` provider abstraction. Test: same bytes twice → second call sees `alreadyExisted=true` and skips upload.

## Task 5: parent-chain helper

**Files:**

- Create: `server/src/services/artifacts/parent-chain.ts`
- Create: `server/src/services/artifacts/__tests__/parent-chain.test.ts`

Pure function `findParentForName(db, { companyId, issueId, name })` returning the latest non-superseded artifact id with that `(issue_id, name)`. When new manifest is inserted, caller wraps in a transaction: insert new → set old's `superseded_at`, `superseded_by_id`. Tests use a mocked Drizzle select chain (same pattern as `pgvector-wiki-backend-upsert.test.ts`).

## Task 6: ArtifactsService default implementation

**Files:**

- Create: `server/src/services/artifacts/service.ts`
- Create: `server/src/services/artifacts/__tests__/service.test.ts`

In-process implementation. `declare()` flow: tenant-gate via `assertTenant`, validate `kind` against the registry, `hashAndStore` the blob, `findParentForName`, transaction inserts the manifest row + supersedes the prior. `list()` filters by issue/run, returns hydrated `DeclaredArtifact[]`. `get()` honors tenant gate. `forget()` soft-deletes via `superseded_at + forget_reason` (need to add `forget_reason TEXT` column — fold into Task 1's migration). The `requestPreview` flag enqueues a preview job via the registry (Task 12). Tests: tenant mismatch rejected on every method; same `(issue_id, name)` declared twice → second `superseded=true`; unknown kind rejected; oversized inline blob rejected (cap at e.g. 16MB inline; larger goes via blobUri).

## Task 7: REST endpoints

**Files:**

- Create: `server/src/routes/artifacts.ts`
- Create: `server/src/routes/__tests__/artifacts.test.ts`
- Modify: `server/src/api-router.ts` — register the new routes.

`GET /api/issues/:issueId/artifacts` → list for the caller's company, scoped to issue. `GET /api/artifacts/:id` → single fetch. `GET /preview/:artifactId/*` → proxies to the preview provider's URL. Uses the existing auth middleware; resolves the caller's company from the session.

## Task 8: in-process adapter wrapper

**Files:**

- Create: `packages/adapter-utils/src/artifacts-helper.ts`
- Modify: `packages/adapters/claude-local/src/server/execute.ts` — call the helper when the adapter detects a `declare_artifact` tool call in the agent's output.
- Modify: `packages/adapters/gemini-local/src/server/execute.ts` — same.
- Create: `packages/adapter-utils/src/__tests__/artifacts-helper.test.ts`

The helper takes an `ArtifactsService` reference + run context, exposes a `declareFromAdapter({ kind, name, ... })` method. Adapters wire it as a callback so the service is injected without each adapter taking a direct dependency on the server module. Tests mock the service.

## Task 9: proto extension

**Files:**

- Create: `proto/worker/v1/artifacts.proto`
- Modify: `proto/worker/v1/messages.proto` — extend `WorkerToServer.payload` `oneof` with `ArtifactDeclared`.
- Run buf script to regenerate; commit the generated TS bindings.

`ArtifactDeclared` per the spec: `run_id`, `kind`, `name`, `content_type`, `content_meta_json` (bytes), `inline_bytes`, `blob_uri`, `request_preview`. Server returns `ArtifactDeclareAck { id, superseded, previewQueued }`.

## Task 10: connect-handler routing

**Files:**

- Modify: `server/src/worker-rpc/connect-handler.ts`
- Create: `server/src/worker-rpc/__tests__/artifact-routing.test.ts`

Add a case in the existing `handleWorkerToServer` switch for the new `ArtifactDeclared` variant. Resolve the run's company from `heartbeat_runs`; call `artifactsService.declare(...)`; reply on the same stream with the ack frame. Tenant-mismatch + unknown-run cases return errors. Test mocks the worker stream.

## Task 11: worker-side helper

**Files:**

- Create: `packages/worker/src/services/artifacts.ts`
- Create: `packages/worker/src/services/__tests__/artifacts.test.ts`
- Modify: `packages/worker/src/run-handler.ts` (or wherever the run loop lives) — expose the helper as part of the run-context API so adapter SDKs in the worker container can call it.

`declareArtifact({ kind, name, contentBytes | filePath, contentMeta, requestPreview })` — buffers the bytes (or streams via blob_uri for >16MB), sends the proto frame on the existing client stream, awaits the ack, returns the assigned id. Tests mock the stream.

## Task 12: preview provider — types + local + registry

**Files:**

- Create: `server/src/services/artifacts/preview/types.ts`
- Create: `server/src/services/artifacts/preview/local.ts`
- Create: `server/src/services/artifacts/preview/registry.ts`
- Create: `server/src/services/artifacts/preview/__tests__/local.test.ts`

Types per the spec's `PreviewProvider` interface. Local provider supports `code.file` (syntax-highlighted), `doc.markdown` (rendered), `chart` (SVG passthrough or vega-lite render), `data.table` (HTML table render), `image` (passthrough). Explicitly refuses `web.app` (security: don't run untrusted code on the control plane). Registry resolves kind → first provider that accepts it. Default provider env-configured (`ARTIFACTS_PREVIEW_PROVIDER_DEFAULT=local`).

## Task 13: preview reaper

**Files:**

- Create: `server/src/services/artifacts/preview/reaper.ts`
- Create: `server/src/services/artifacts/preview/__tests__/reaper.test.ts`
- Modify: `server/src/index.ts` — start the reaper alongside `startReflectionWorker`.

Pure tick: scan `artifacts WHERE preview_expires_at < now AND preview_url IS NOT NULL`, call provider's `teardown`, null the URL. Production wire is the same `setInterval.unref()` pattern as the lease reaper (Plan 2 of distributed-workers) and the reflection worker. Default interval 5 minutes per the spec.

## Task 14: heartbeat run-summary integration

**Files:**

- Modify: `server/src/services/heartbeat-run-summary.ts` — append a "Work products" section listing artifacts declared during the run.
- Modify: `server/src/__tests__/heartbeat-run-summary.test.ts` — extend.

Pure-string concat; no DB writes — the summary fetches from `artifacts WHERE run_id = $1`.

## Task 15: UI Work Products tab

**Files:**

- Create: `ui/src/features/issues/work-products/WorkProductsTab.tsx`
- Create: `ui/src/features/issues/work-products/ArtifactRow.tsx`
- Create: `ui/src/features/issues/work-products/renderers/{index,code-file,code-patch,doc-markdown,chart,data-table,web-app}.tsx`
- Create: `ui/src/features/issues/work-products/__tests__/WorkProductsTab.test.tsx`
- Modify: `ui/src/features/issues/IssueDetail.tsx` — register the tab.

List view shows kind icon, name, declared-by-run, preview link if active, parent-chain depth indicator. Per-kind renderer for the detail panel. Reuses the existing inbox primitives (Card, Pill, etc.). Tests use the existing `vitest + @testing-library/react` setup.

## Task 16: back-compat view over `issue_work_products`

**Files:**

- Modify: `packages/db/src/migrations/0085_artifacts_foundation.sql` — append `CREATE OR REPLACE VIEW issue_work_products_legacy AS SELECT … FROM artifacts ...`.
- Create: `server/src/services/artifacts/__tests__/legacy-compat.test.ts`

Map the new schema to the prior `issue_work_products` shape. Plugins still reading the old table get a stable surface for one release cycle. The base table `issue_work_products` itself stays read-only after this plan lands; new declares only write to `artifacts`. A separate Plan 2 migration drops `issue_work_products` entirely once consumers move.

## Task 17: telemetry + metrics

**Files:**

- Modify: `server/src/observability/otel.ts` — register the new counters / histograms.
- Modify: `server/src/services/artifacts/service.ts` — emit spans `paperclip.artifact.declare`, `paperclip.artifact.preview.materialize`, `paperclip.artifact.preview.teardown`.
- Create: `server/src/services/artifacts/__tests__/telemetry.test.ts`

Counters per the spec: `paperclip_artifacts_declared_total{kind}`, `paperclip_artifact_blob_bytes_total{provider}`, `paperclip_artifact_preview_active_count`, `paperclip_artifact_preview_materialize_latency_ms`. Tests verify span attributes via the in-memory exporter.

## Task 18: green build + ROADMAP touch-up

**Files:**

- Verify: `pnpm -r exec tsc --noEmit` clean.
- Verify: `pnpm test` clean per package.
- Modify: `ROADMAP.md` — flip Artifacts & Work Products from ⚪ to 🚧 with a one-paragraph summary.

End-to-end smoke: the embedded-postgres-backed integration test declares an artifact, lists it, fetches the preview, supersedes it, and confirms the parent chain is intact.

---

## Risks (operator-facing)

- **Storage cost runaway.** Hot codebases declaring `code.file` per run could blow up storage fast. Plan 2 ships the orphan-blob GC sweep; this plan relies on content-addressing + per-company `blob_retention_days` (defaulted high). Operators monitor `paperclip_artifact_blob_bytes_total` for early signals.
- **`issue_work_products` consumers.** Anything reading the old table directly stops getting fresh writes after Task 16. The legacy view backfills the read shape, but custom plugins doing INSERT/UPDATE will break — surface this in the release notes.
- **Preview-provider security.** Local provider explicitly refuses `web.app`. Plan 2's e2b / Cloudflare providers handle that kind safely; until they ship, `web.app` artifacts declare cleanly but show "preview unavailable" in the UI.
- **Adapter declaration races.** Two parallel `declare_artifact` calls for the same `(issue_id, name)` — the partial-unique-on-name-WHERE-not-superseded protects via Postgres; the loser of the race retries (idempotent — sha-based dedupe means the duplicate blob write is a no-op).

---

*Draft: 2026-05-15. Builds on the artifacts spec dated 2026-05-13. Ready to execute task-by-task.*
