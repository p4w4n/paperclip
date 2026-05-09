import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { plans } from "./plans.js";
import { agents } from "./agents.js";

// plan_phases — phase rows belonging to a plan. ordering is the
// linearization (UI sort key); plan_phase_dependencies is the DAG.
// status: pending → ready → in_progress → completed | skipped | blocked.
export const planPhases = pgTable(
  "plan_phases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    ordering: integer("ordering").notNull(),
    name: text("name").notNull(),
    descriptionMarkdown: text("description_markdown"),
    exitCriteriaMarkdown: text("exit_criteria_markdown"),
    status: text("status").notNull().default("pending"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    planIdx: index("plan_phases_plan_idx").on(table.planId, table.ordering),
  }),
);
