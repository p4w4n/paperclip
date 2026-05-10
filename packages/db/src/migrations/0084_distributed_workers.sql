CREATE TABLE "worker_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"zone" text,
	"image" text,
	"adapters" jsonb NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"version" text
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "dispatched_to_worker_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "worker_session_id" uuid;--> statement-breakpoint
CREATE INDEX "worker_sessions_worker_id_idx" ON "worker_sessions" USING btree ("worker_id");
-- Note: drizzle-kit also re-emits documents_title_search_idx and
-- documents_latest_body_search_idx here because the schema declares them
-- but its `meta` snapshot doesn't carry them forward from migration 0079
-- (which created them with IF NOT EXISTS). Removed manually — applying
-- them again without IF NOT EXISTS would fail on every existing database.