CREATE TABLE "workspace_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"held_by_run_id" uuid,
	"held_by_worker_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "filestore_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_leases" ADD CONSTRAINT "workspace_leases_held_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("held_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_leases_workspace_expires_idx" ON "workspace_leases" USING btree ("project_workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "workspace_leases_run_idx" ON "workspace_leases" USING btree ("held_by_run_id");--> statement-breakpoint
-- Partial unique: at most one active (un-released) lease per workspace.
-- This is the actual lock — Postgres rejects a second insert into the
-- same project_workspace_id while the prior row's released_at is null.
-- Added by hand because drizzle-kit doesn't represent partial-WHERE
-- uniques on column declarations cleanly.
CREATE UNIQUE INDEX "workspace_leases_active_workspace_uniq" ON "workspace_leases" ("project_workspace_id") WHERE "released_at" IS NULL;