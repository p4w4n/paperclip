import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { memoryPages } from "./memory_pages.js";

// Internal links between wiki pages — a directed graph. Both ends
// are always within the same company (enforced by the service layer
// via memoryService.upsertPage). The recall step traverses 1 hop
// from a hit by default to surface neighbor pages at half-weight.
export const memoryPageLinks = pgTable(
  "memory_page_links",
  {
    fromPageId: uuid("from_page_id")
      .notNull()
      .references(() => memoryPages.id, { onDelete: "cascade" }),
    toPageId: uuid("to_page_id")
      .notNull()
      .references(() => memoryPages.id, { onDelete: "cascade" }),
    linkText: text("link_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fromPageId, table.toPageId] }),
    toIdx: index("memory_page_links_to_idx").on(table.toPageId),
  }),
);
