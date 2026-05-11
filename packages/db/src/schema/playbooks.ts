import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// playbooks — structured procedural runbooks. Distinct from
// memory_pages (free-form wiki) by virtue of applicability_conditions
// + status lifecycle. Slug uniqueness within the active scope is
// enforced by the partial unique in 0090.
export const playbooks = pgTable(
  "playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("proposed"),
    currentRevisionId: uuid("current_revision_id"),
    currentRevisionNumber: integer("current_revision_number").notNull().default(1),
    applicabilityConditions: jsonb("applicability_conditions").$type<Record<string, unknown>>(),
    sourceRunIds: text("source_run_ids").array(),
    sourcePlanIds: text("source_plan_ids").array(),
    confidence: real("confidence").notNull().default(0.5),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    suggestedOutcomes: jsonb("suggested_outcomes").$type<unknown[]>().notNull().default([]),
  },
  (table) => ({
    companyStatusIdx: index("playbooks_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    agentIdx: index("playbooks_agent_idx").on(table.agentId),
  }),
);
