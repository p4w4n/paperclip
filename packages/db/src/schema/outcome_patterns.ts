import { index, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";
import { companies } from "./companies.js";
import { playbooks } from "./playbooks.js";

// outcome_patterns — mined clusters of similar resolutions. Promoted
// to a playbook by operator action (or planner agent in Plan 2).
export const outcomePatterns = pgTable(
  "outcome_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, {
      onDelete: "cascade",
    }),
    patternName: text("pattern_name").notNull(),
    patternDescription: text("pattern_description"),
    exemplarRunIds: text("exemplar_run_ids").array().notNull(),
    clusterSize: integer("cluster_size").notNull(),
    derivedAt: timestamp("derived_at", { withTimezone: true }).notNull().defaultNow(),
    confidence: real("confidence").notNull().default(0.5),
    promotedToPlaybookId: uuid("promoted_to_playbook_id").references(
      () => playbooks.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("outcome_patterns_company_idx").on(
      table.companyId,
      desc(table.derivedAt),
    ),
  }),
);
