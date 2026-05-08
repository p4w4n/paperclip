import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projectWorkspaces } from "./project_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Plan 4: workspace lease table. One active lease per project_workspace
// when filestore_mode = "on" — that's the lock that serializes
// concurrent runs targeting the same shared filesystem path.
//
// The actual concurrency oracle is a partial unique index
// `WHERE released_at IS NULL` declared in the migration SQL (drizzle-
// kit doesn't represent partial uniques on a column level cleanly, so
// the index lives in 0083_workspace_leases.sql by hand). Postgres
// rejects a second insert into the same workspace while the prior row
// is still held; acquire is just an INSERT with the unique violation
// translated to "busy" by the lease store.
//
// Lifecycle:
//  1. dispatch-or-local acquires (INSERT) before tryDispatch.
//  2. expires_at mirrors the run-lease window so the workspace-lease
//     reaper releases orphaned rows when a worker dies (expires_at <
//     now() AND released_at IS NULL).
//  3. On RunComplete / RunFailed, dispatch-or-local calls release(id)
//     which sets released_at = now().
export const workspaceLeases = pgTable(
  "workspace_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    // FK with set-null on delete so a (rare) run-row delete doesn't
    // cascade-delete lease audit history.
    heldByRunId: uuid("held_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    heldByWorkerId: text("held_by_worker_id"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL = currently held; non-null = released (kept for audit).
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceExpiresIdx: index("workspace_leases_workspace_expires_idx").on(
      table.projectWorkspaceId,
      table.expiresAt,
    ),
    runIdx: index("workspace_leases_run_idx").on(table.heldByRunId),
  }),
);
