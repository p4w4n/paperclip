import {
  type AnyPgColumn,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { plans } from "./plans.js";
import { agents } from "./agents.js";

// plan_revisions — versioned snapshots of the plan body. Snapshot+
// parent like document_revisions and memory_pages. Diffs derived
// lazily for the UI.
export const planRevisions = pgTable(
  "plan_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => planRevisions.id,
      { onDelete: "set null" },
    ),
    contentMarkdown: text("content_markdown").notNull(),
    changeSummary: text("change_summary"),
    status: text("status").notNull().default("proposed"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planRevNumUq: uniqueIndex("plan_revisions_plan_revnum_uniq").on(
      table.planId,
      table.revisionNumber,
    ),
  }),
);
