// github_webhook_deliveries — audit table for GitHub PR-merged webhook ingestion.
// Replay protection via (company_id, delivery_id) unique index;
// idempotency-key behavior at the verifier level reuses the same delivery_id.

import { boolean, index, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { outcomes } from "./outcomes.js";

export const githubWebhookDeliveries = pgTable(
  "github_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    prUrl: text("pr_url"),
    outcomeId: uuid("outcome_id").references(() => outcomes.id, { onDelete: "set null" }),
    signatureValid: boolean("signature_valid").notNull(),
    result: text("result").notNull(),  // 'verified' | 'no_match' | 'invalid_signature' | 'ignored'
    rawBodySha256: text("raw_body_sha256").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDeliveryUniq: uniqueIndex("github_webhook_deliveries_uniq").on(table.companyId, table.deliveryId),
    companyReceivedIdx: index("github_webhook_deliveries_company_idx").on(table.companyId, table.receivedAt),
  }),
);

export type GithubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferSelect;
