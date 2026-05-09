CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue" text DEFAULT 'default' NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"dedupe_key" text,
	"target_issue_id" uuid,
	"target_agent_id" uuid,
	"routine_id" uuid,
	"payload" jsonb,
	"state" text DEFAULT 'queued' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"retry_policy" jsonb,
	"enqueued_by_kind" text NOT NULL,
	"enqueued_by_ref" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"run_id" uuid,
	"last_error" text,
	"last_error_code" text
);
--> statement-breakpoint
CREATE TABLE "work_queue_tenant_credits" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"recent_dequeued" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "enqueue_via_work_queue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "default_retry_policy" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_queue_tenant_credits" ADD CONSTRAINT "work_queue_tenant_credits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_company_state_idx" ON "work_items" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "work_items_run_idx" ON "work_items" USING btree ("run_id");--> statement-breakpoint
-- Hand-edited partial indexes (drizzle-kit doesn't emit partial WHERE):
-- Idempotency: at most one un-completed item per (company_id, dedupe_key).
CREATE UNIQUE INDEX "work_items_dedupe_active_uniq" ON "work_items"
  ("company_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "state" IN ('queued', 'running');--> statement-breakpoint
-- Dequeue path: the scheduler's hot SELECT.
CREATE INDEX "work_items_dequeue_idx" ON "work_items"
  ("company_id", "queue", "priority" DESC, "available_at")
  WHERE "state" = 'queued';--> statement-breakpoint
-- Dead-letter inspection: admin UI lists by recency.
CREATE INDEX "work_items_dead_letter_idx" ON "work_items"
  ("company_id", "completed_at" DESC)
  WHERE "state" = 'dead_letter';