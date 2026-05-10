import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// outcomes — one row per required-outcome slot on a gated entity (issue or plan).
// status lifecycle: pending → verified → reverted.
// Polymorphic target_kind/target_id FK is enforced in code (no DB FK — target may be
// an issue or a plan). companyId cascade-delete provides tenant isolation.
export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Polymorphic FK enforced in code (target_kind ∈ {issue, plan}, target_id is the row id).
    targetKind: text("target_kind").notNull(), // 'issue' | 'plan'
    targetId: uuid("target_id").notNull(),

    kind: text("kind").notNull(), // see OUTCOME_KINDS
    status: text("status").notNull().default("pending"), // 'pending' | 'verified' | 'reverted'

    requiredMeta: jsonb("required_meta").notNull().default({}),
    verifiedMeta: jsonb("verified_meta"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByKind: text("verified_by_kind"), // 'agent' | 'user' | 'system' | 'webhook'
    verifiedById: uuid("verified_by_id"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertedReason: text("reverted_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetIdx: index("outcomes_target_idx").on(table.companyId, table.targetKind, table.targetId),
    // Partial pending-only and contract-uniq + idem-uniq indexes are hand-edited in the SQL migration
    // — drizzle-kit doesn't support partial WHERE. Same hand-edit pattern as prior Tier-1 migrations.
  }),
);

export type OutcomeRow = typeof outcomes.$inferSelect;
export type NewOutcomeRow = typeof outcomes.$inferInsert;
