import {
  index,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// agent_skills — per-agent profile derived by the skill miner.
// Free-form skill_name; confidence tracks evidence + decay.
export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, {
      onDelete: "cascade",
    }),
    companyId: uuid("company_id").notNull().references(() => companies.id, {
      onDelete: "cascade",
    }),
    skillName: text("skill_name").notNull(),
    evidenceRunIds: text("evidence_run_ids").array().notNull(),
    lastEvidencedAt: timestamp("last_evidenced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confidence: real("confidence").notNull().default(0.5),
    derivedAt: timestamp("derived_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.skillName] }),
    companyIdx: index("agent_skills_company_idx").on(table.companyId),
  }),
);
