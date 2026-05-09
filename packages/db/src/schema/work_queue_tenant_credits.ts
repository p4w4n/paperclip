import { integer, pgTable, real, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Per-company fairness counter. weight is operator-tuned; the
// scheduler walks (weight - recent_dequeued) desc and resets the
// counter every tick (rolling-tick window).
export const workQueueTenantCredits = pgTable("work_queue_tenant_credits", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  weight: real("weight").notNull().default(1.0),
  recentDequeued: integer("recent_dequeued").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
