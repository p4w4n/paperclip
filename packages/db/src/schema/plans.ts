import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

// plans — first-class container for strategy-heavy work.
// One plan per issue (optional). Status drives a strict lifecycle:
//   draft → under_review → approved → in_progress → completed
// (or cancelled / rejected at pre-progress points). approval_policy
// determines whether revision after revision keeps re-triggering
// review; phase_advance_policy decides whether phases auto-start
// when their deps complete.
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    currentRevisionId: uuid("current_revision_id"),
    currentRevisionNumber: integer("current_revision_number").notNull().default(1),
    approvalPolicy: text("approval_policy").notNull().default("one_human"),
    phaseAdvancePolicy: text("phase_advance_policy").notNull().default("auto"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    requiredOutcomes: jsonb("required_outcomes").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("plans_company_status_idx").on(table.companyId, table.status),
    issueIdx: index("plans_issue_idx").on(table.issueId),
  }),
);
