import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { planPhases } from "./plan_phases.js";

// plan_phase_dependencies — DAG edges. (from, to) means to-phase
// blocks on from-phase completion. Cycle prevention is service-
// layer (DFS check before insert); SQL doesn't enforce it.
export const planPhaseDependencies = pgTable(
  "plan_phase_dependencies",
  {
    fromPhaseId: uuid("from_phase_id")
      .notNull()
      .references(() => planPhases.id, { onDelete: "cascade" }),
    toPhaseId: uuid("to_phase_id")
      .notNull()
      .references(() => planPhases.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fromPhaseId, table.toPhaseId] }),
  }),
);
