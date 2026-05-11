// plan_templates — reusable contracts for plans, materialized at plan creation
// (single-shot copy, no live binding). Mirrors routines.default_required_outcomes
// for the plan surface. EO Plan 2.

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const planTemplates = pgTable(
  "plan_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    defaultRequiredOutcomes: jsonb("default_required_outcomes").$type<unknown[]>().notNull().default([]),
    defaultPhases: jsonb("default_phases").$type<unknown[]>().notNull().default([]),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Partial-WHERE indexes are hand-edited in the SQL migration.
);

export type PlanTemplateRow = typeof planTemplates.$inferSelect;
export type NewPlanTemplateRow = typeof planTemplates.$inferInsert;
