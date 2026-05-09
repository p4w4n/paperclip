CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"blob_sha256" text NOT NULL,
	"blob_bytes" bigint NOT NULL,
	"blob_storage_provider" text NOT NULL,
	"blob_storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"content_meta" jsonb,
	"parent_id" uuid,
	"preview_url" text,
	"preview_expires_at" timestamp with time zone,
	"preview_provider" text,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declared_by_agent_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"forget_reason" text
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_declared_by_agent_id_agents_id_fk" FOREIGN KEY ("declared_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifacts_issue_idx" ON "artifacts" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_kind_idx" ON "artifacts" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "artifacts_sha_idx" ON "artifacts" USING btree ("blob_sha256");--> statement-breakpoint
-- Partial unique on (issue_id, name) — at most one active artifact
-- per issue per logical name. Hand-edited because drizzle-kit
-- doesn't emit partial-WHERE indexes (precedent: 0084 memory pages
-- slug uniq). issue_id NULL coalesced via the explicit form so two
-- run-scoped (no issue) artifacts don't collide on a generic name.
CREATE UNIQUE INDEX "artifacts_name_scope_uniq" ON "artifacts"
  (COALESCE("issue_id"::text, ''), "name")
  WHERE "superseded_at" IS NULL;