import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { routines } from "./routines.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// work_items — durable queued-but-not-yet-dispatched work. Plan 1
// of Work Queues. The dequeue index (priority DESC, available_at)
// and the dedupe partial-unique on (company_id, dedupe_key) WHERE
// state IN ('queued','running') are both hand-edited into the
// migration; drizzle-kit doesn't emit partial-WHERE indexes.
export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queue: text("queue").notNull().default("default"),
    priority: smallint("priority").notNull().default(5),
    dedupeKey: text("dedupe_key"),
    targetIssueId: uuid("target_issue_id").references(() => issues.id, { onDelete: "set null" }),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    state: text("state").notNull().default("queued"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    retryPolicy: jsonb("retry_policy").$type<Record<string, unknown>>(),
    enqueuedByKind: text("enqueued_by_kind").notNull(),
    enqueuedByRef: text("enqueued_by_ref"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => ({
    companyStateIdx: index("work_items_company_state_idx").on(table.companyId, table.state),
    runIdx: index("work_items_run_idx").on(table.runId),
  }),
);
