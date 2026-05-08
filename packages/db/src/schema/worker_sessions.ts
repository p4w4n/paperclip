import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

export const workerSessions = pgTable(
  "worker_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: text("worker_id").notNull(),
    instanceId: text("instance_id").notNull(),
    zone: text("zone"),
    image: text("image"),
    adapters: jsonb("adapters").$type<string[]>().notNull(),
    maxConcurrent: integer("max_concurrent").notNull().default(1),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    version: text("version"),
  },
  (table) => ({
    workerIdIdx: index("worker_sessions_worker_id_idx").on(table.workerId),
  }),
);
