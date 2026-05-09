import {
  type AnyPgColumn,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { playbooks } from "./playbooks.js";
import { agents } from "./agents.js";

// playbook_revisions — versioned snapshots of the body. Snapshot+
// parent like memory_pages and plan_revisions.
export const playbookRevisions = pgTable(
  "playbook_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playbookId: uuid("playbook_id").notNull().references(() => playbooks.id, {
      onDelete: "cascade",
    }),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => playbookRevisions.id,
      { onDelete: "set null" },
    ),
    contentMarkdown: text("content_markdown").notNull(),
    changeSummary: text("change_summary"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    playbookRevNumUq: uniqueIndex("playbook_revisions_pb_revnum_uniq").on(
      table.playbookId,
      table.revisionNumber,
    ),
  }),
);
