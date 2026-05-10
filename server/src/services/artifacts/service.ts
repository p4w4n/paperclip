// Default in-process ArtifactsService.
//
// declare() flow:
//   1. assertTenant — caller's company must match input.scope.
//   2. validateContentMeta — known kind + meta passes the kind's
//      schema, else throw with a clear message.
//   3. resolve bytes — either inline or via blob_uri (blobUri path
//      requires the storage provider to support fetch-and-store;
//      v1 only handles inline; blobUri throws not_implemented and
//      Plan 2 wires up the async fetcher).
//   4. hashAndStore — content-addressed dedup.
//   5. transaction: findParentForName → insert manifest → if parent,
//      supersede it.
//   6. Optional preview enqueue (placeholder; A-12 wires it).
//
// list / get / forget mirror the MemoryService shape. forget is a
// soft delete — supersededAt + forget_reason; the partial unique
// admits a fresh declaration at the same (issue, name).

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifacts } from "@paperclipai/db";
import {
  isKnownArtifactKind,
  validateContentMeta,
} from "@paperclipai/shared";
import type { StorageProvider } from "../../storage/types.js";
import { hashAndStore } from "./blob-store.js";
import {
  recordArtifactBlobBytes,
  recordArtifactDeclared,
} from "./metrics.js";
import { findParentForName } from "./parent-chain.js";
import { artifactsEvents } from "./events.js";
import {
  ArtifactsTenantMismatchError,
  type ArtifactsService,
  type ArtifactsServiceContext,
  type DeclareInput,
  type DeclareResult,
  type DeclaredArtifact,
  type ForgetInput,
  type ListInput,
} from "./types.js";

const MAX_INLINE_BYTES = 16 * 1024 * 1024; // 16 MB cap; larger via blob_uri path (Plan 2).

export interface ArtifactsServiceOpts {
  db: Db;
  storageProvider: StorageProvider;
}

export function createArtifactsService(opts: ArtifactsServiceOpts): ArtifactsService {
  function assertTenant(ctx: ArtifactsServiceContext, inputCompanyId: string): void {
    if (ctx.callerCompanyId !== inputCompanyId) {
      throw new ArtifactsTenantMismatchError(ctx.callerCompanyId, inputCompanyId);
    }
  }

  return {
    async declare(ctx, input) {
      assertTenant(ctx, input.scope.companyId);

      if (!isKnownArtifactKind(input.kind)) {
        throw new Error(`unknown artifact kind: ${input.kind}`);
      }
      const validation = validateContentMeta(input.kind, input.contentMeta);
      if (!validation.ok) {
        throw new Error(
          `invalid content_meta for ${input.kind}: ${validation.errors.join("; ")}`,
        );
      }

      if (!input.contentBytes && !input.blobUri) {
        throw new Error("declare requires either contentBytes or blobUri");
      }
      if (input.blobUri) {
        // Plan 2: server-side fetch-and-store from a worker-uploaded
        // signed URL. v1 keeps to inline.
        throw new Error("blobUri-based declare is not supported in v1; use contentBytes");
      }
      if (!input.contentBytes) {
        throw new Error("contentBytes is required");
      }
      if (input.contentBytes.byteLength > MAX_INLINE_BYTES) {
        throw new Error(
          `inline artifact exceeds ${MAX_INLINE_BYTES} bytes; the blobUri path lands in Plan 2`,
        );
      }

      const blob = await hashAndStore({
        companyId: input.scope.companyId,
        bytes: input.contentBytes,
        contentType: input.contentType,
        provider: opts.storageProvider,
      });
      if (!blob.alreadyExisted) {
        recordArtifactBlobBytes(blob.blobStorageProvider, blob.blobBytes);
      }

      const declared: DeclareResult = await opts.db.transaction(async (tx) => {
        const parentId = await findParentForName({
          db: tx as unknown as Db,
          companyId: input.scope.companyId,
          issueId: input.scope.issueId ?? null,
          name: input.name,
        });

        const [row] = await tx
          .insert(artifacts)
          .values({
            companyId: input.scope.companyId,
            runId: input.scope.runId ?? null,
            issueId: input.scope.issueId ?? null,
            kind: input.kind,
            name: input.name,
            blobSha256: blob.blobSha256,
            blobBytes: blob.blobBytes,
            blobStorageProvider: blob.blobStorageProvider,
            blobStorageKey: blob.blobStorageKey,
            contentType: input.contentType,
            contentMeta:
              (input.contentMeta as Record<string, unknown> | undefined) ?? null,
            parentId,
            declaredByAgentId: input.scope.declaredByAgentId ?? null,
          })
          .returning({ id: artifacts.id });

        if (parentId) {
          await tx
            .update(artifacts)
            .set({
              supersededAt: new Date(),
              supersededById: row.id,
            })
            .where(eq(artifacts.id, parentId));
        }

        return {
          id: row.id,
          superseded: parentId !== null,
          // A-12 wires the preview registry; until then no previews
          // are enqueued.
          previewQueued: false,
        };
      });

      recordArtifactDeclared(input.kind);

      // Emit AFTER the transaction commits — never inside it.
      // A verifier crash must NOT roll back the source write.
      artifactsEvents.emit("declared", {
        id: declared.id,
        companyId: input.scope.companyId,
        issueId: input.scope.issueId ?? null,
        kind: input.kind,
        name: input.name,
        blobSha256: blob.blobSha256,
        declaredAt: new Date(),
      });

      return declared;
    },

    async list(ctx, input: ListInput) {
      assertTenant(ctx, input.companyId);
      const limit = input.limit ?? 100;
      const filters = [eq(artifacts.companyId, input.companyId)];
      if (input.issueId) filters.push(eq(artifacts.issueId, input.issueId));
      if (input.runId) filters.push(eq(artifacts.runId, input.runId));
      if (!input.includeSuperseded) filters.push(isNull(artifacts.supersededAt));
      const rows = await opts.db
        .select()
        .from(artifacts)
        .where(and(...filters))
        .orderBy(desc(artifacts.declaredAt))
        .limit(limit);
      return rows.map(toDeclared);
    },

    async get(ctx, { id, companyId }) {
      assertTenant(ctx, companyId);
      const [row] = await opts.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, id), eq(artifacts.companyId, companyId)))
        .limit(1);
      return row ? toDeclared(row) : null;
    },

    async forget(ctx, input: ForgetInput) {
      assertTenant(ctx, input.companyId);
      await opts.db
        .update(artifacts)
        .set({
          supersededAt: new Date(),
          forgetReason: input.reason,
        })
        .where(
          and(
            eq(artifacts.id, input.id),
            eq(artifacts.companyId, input.companyId),
            isNull(artifacts.supersededAt),
          ),
        );
    },
  };
}

function toDeclared(row: typeof artifacts.$inferSelect): DeclaredArtifact {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    issueId: row.issueId,
    kind: row.kind,
    name: row.name,
    blobSha256: row.blobSha256,
    blobBytes: row.blobBytes,
    blobStorageProvider: row.blobStorageProvider,
    blobStorageKey: row.blobStorageKey,
    contentType: row.contentType,
    contentMeta: row.contentMeta,
    parentId: row.parentId,
    previewUrl: row.previewUrl,
    previewExpiresAt: row.previewExpiresAt,
    previewProvider: row.previewProvider,
    declaredAt: row.declaredAt,
    declaredByAgentId: row.declaredByAgentId,
    supersededAt: row.supersededAt,
    supersededById: row.supersededById,
  };
}

// Process-wide singleton wiring (mirrors MemoryService).
let singleton: ArtifactsService | null = null;

export function initializeArtifactsService(opts: ArtifactsServiceOpts): ArtifactsService {
  singleton = createArtifactsService(opts);
  return singleton;
}

export function getArtifactsService(): ArtifactsService {
  if (!singleton) {
    throw new Error(
      "ArtifactsService not initialized — call initializeArtifactsService(...) at boot",
    );
  }
  return singleton;
}
