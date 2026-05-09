import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { planPhases } from "./plan_phases.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// plan_phase_runs — phase ↔ run linkage. A phase may have many
// runs (retries, multi-agent collab); a run belongs to at most
// one phase.
export const planPhaseRuns = pgTable(
  "plan_phase_runs",
  {
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => planPhases.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.phaseId, table.runId] }),
  }),
);
