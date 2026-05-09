import {
  type AnyPgColumn,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { plans } from "./plans.js";
import { planPhases } from "./plan_phases.js";
import { agents } from "./agents.js";

// plan_decisions — durable rationale-capture rows. "We considered
// A, B, C; chose B because…". Distinct from review comments —
// reviews are transient cycle state, decisions are the artifacts
// worth preserving (and that the memory reflection worker
// promotes to semantic facts on plan completion).
export const planDecisions = pgTable("plan_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  phaseId: uuid("phase_id").references(() => planPhases.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  optionsJson: jsonb("options_json").$type<Array<{ id: string; label: string }>>().notNull(),
  chosenOptionId: text("chosen_option_id").notNull(),
  rationaleMarkdown: text("rationale_markdown"),
  decidedByUserId: text("decided_by_user_id"),
  decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id, {
    onDelete: "set null",
  }),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  supersededById: uuid("superseded_by_id").references(
    (): AnyPgColumn => planDecisions.id,
    { onDelete: "set null" },
  ),
});
