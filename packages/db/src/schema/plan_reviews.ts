import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";
import { plans } from "./plans.js";
import { planRevisions } from "./plan_revisions.js";
import { agents } from "./agents.js";

// plan_reviews — review-cycle decisions. Stamp a specific revision
// (not the plan as a whole); re-revision retriggers review per the
// approval_policy. Decision: 'approved' | 'requested_changes' |
// 'rejected'.
export const planReviews = pgTable(
  "plan_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id").references(() => planRevisions.id, {
      onDelete: "set null",
    }),
    reviewerUserId: text("reviewer_user_id"),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    decision: text("decision").notNull(),
    commentMarkdown: text("comment_markdown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planIdx: index("plan_reviews_plan_idx").on(table.planId, desc(table.createdAt)),
  }),
);
