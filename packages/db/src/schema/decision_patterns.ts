import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// decision_patterns — aggregated decision rationale across plans.
// "We tend to choose X when [conditions]". superseded_by_id chains
// when the pattern updates as new evidence accumulates.
export const decisionPatterns = pgTable(
  "decision_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, {
      onDelete: "cascade",
    }),
    conditionSummary: text("condition_summary").notNull(),
    typicalChoice: text("typical_choice").notNull(),
    exemplarDecisionIds: text("exemplar_decision_ids").array().notNull(),
    clusterSize: integer("cluster_size").notNull(),
    derivedAt: timestamp("derived_at", { withTimezone: true }).notNull().defaultNow(),
    confidence: real("confidence").notNull().default(0.5),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => decisionPatterns.id,
      { onDelete: "set null" },
    ),
  },
  (table) => ({
    companyIdx: index("decision_patterns_company_idx").on(table.companyId),
  }),
);
