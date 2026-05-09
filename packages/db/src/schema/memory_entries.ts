import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// pgvector type isn't first-class in drizzle-orm — wrap a customType.
// Drives the storage round-trip: Postgres stores `vector(N)`, we read
// the canonical `[1,2,3]` text form back as a number[].
const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (value) => `[${value.join(",")}]`,
    fromDriver: (raw) => JSON.parse(raw as string),
  });

// memory_entries — fact-per-row half of the Karpathy three-layer
// model. Episodic captured automatically (run boundaries + comments);
// semantic + procedural derived by the reflection worker. Scope keys
// (company / user / agent / session) form the Mem0-2026 union-rank
// taxonomy. The HNSW partial index lives in the migration SQL because
// drizzle-kit doesn't emit partial-WHERE indexes; see
// 0084_memory_foundation.sql.
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id"),
    sessionKind: text("session_kind"),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    embedding: vector(1024)("embedding"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    salience: real("salience").notNull().default(0.5),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    forgetReason: text("forget_reason"),
  },
  (table) => ({
    companyIdx: index("memory_entries_company_idx").on(table.companyId),
    agentIdx: index("memory_entries_agent_idx").on(table.agentId),
    sessionIdx: index("memory_entries_session_idx").on(
      table.companyId,
      table.sessionKind,
      table.sessionId,
    ),
    userIdx: index("memory_entries_user_idx").on(table.userId),
  }),
);
