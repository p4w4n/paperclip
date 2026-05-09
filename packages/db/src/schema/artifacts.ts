import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// artifacts — unified manifest for typed agent outputs (Plan 1 of
// Artifacts & Work Products). Polymorphic on (run_id, issue_id);
// content-addressed via blob_sha256 so the same artifact across
// runs dedupes at the storage layer (only the manifest is
// duplicated). parent_id chains revisions when the same
// (issue_id, name) is re-declared. The partial unique on
// (issue_id, name) WHERE superseded_at IS NULL is hand-edited into
// the migration (drizzle-kit doesn't emit partial WHERE).
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    blobSha256: text("blob_sha256").notNull(),
    blobBytes: bigint("blob_bytes", { mode: "number" }).notNull(),
    blobStorageProvider: text("blob_storage_provider").notNull(),
    blobStorageKey: text("blob_storage_key").notNull(),
    contentType: text("content_type").notNull(),
    contentMeta: jsonb("content_meta").$type<Record<string, unknown>>(),
    parentId: uuid("parent_id"),
    previewUrl: text("preview_url"),
    previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }),
    previewProvider: text("preview_provider"),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    declaredByAgentId: uuid("declared_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
    forgetReason: text("forget_reason"),
  },
  (table) => ({
    runIdx: index("artifacts_run_idx").on(table.runId),
    issueIdx: index("artifacts_issue_idx").on(table.issueId),
    companyKindIdx: index("artifacts_company_kind_idx").on(table.companyId, table.kind),
    shaIdx: index("artifacts_sha_idx").on(table.blobSha256),
  }),
);
