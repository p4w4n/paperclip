import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";

const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (value) => `[${value.join(",")}]`,
    fromDriver: (raw) => JSON.parse(raw as string),
  });

// memory_pages — the wiki-page half of the Karpathy three-layer
// model. Markdown documents at one scope per page; never spans
// scopes. Versioned via parent_id chain — every lint or upsert
// produces a new revision; older revisions stay for audit.
//
// The unique key is (company_id, agent_id, user_id, session_id, slug)
// WHERE superseded_at IS NULL — same partial-unique lock pattern as
// workspace_leases from workers Plan 4. The unique lives in the
// migration SQL; drizzle-kit doesn't emit partial uniques.
export const memoryPages = pgTable(
  "memory_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id"),
    sessionKind: text("session_kind"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    embedding: vector(1024)("embedding"),
    parentId: uuid("parent_id"),
    sourceEntryIds: text("source_entry_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLintedAt: timestamp("last_linted_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    lintStatus: text("lint_status"),
    lintNotes: text("lint_notes"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    forgetReason: text("forget_reason"),
  },
  (table) => ({
    companyIdx: index("memory_pages_company_idx").on(table.companyId),
    agentIdx: index("memory_pages_agent_idx").on(table.agentId),
    userIdx: index("memory_pages_user_idx").on(table.userId),
    sessionIdx: index("memory_pages_session_idx").on(
      table.companyId,
      table.sessionKind,
      table.sessionId,
    ),
  }),
);
