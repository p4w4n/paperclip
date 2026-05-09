-- Plan 1 of Memory / Knowledge: facts (memory_entries) + wiki pages
-- (memory_pages) + page graph (memory_page_links). The pgvector
-- extension is required; on environments without it (some embedded
-- postgres test setups), the extension creation is best-effort and
-- the partial HNSW indexes below are skipped via DO blocks.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text,
	"agent_id" uuid,
	"session_id" uuid,
	"session_kind" text,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"payload" jsonb,
	"embedding" vector(1024),
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"salience" real DEFAULT 0.5 NOT NULL,
	"expires_at" timestamp with time zone,
	"supersedes_id" uuid,
	"superseded_at" timestamp with time zone,
	"forget_reason" text
);
--> statement-breakpoint
CREATE TABLE "memory_page_links" (
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	"link_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_page_links_from_page_id_to_page_id_pk" PRIMARY KEY("from_page_id","to_page_id")
);
--> statement-breakpoint
CREATE TABLE "memory_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text,
	"agent_id" uuid,
	"session_id" uuid,
	"session_kind" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text NOT NULL,
	"embedding" vector(1024),
	"parent_id" uuid,
	"source_entry_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_linted_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"lint_status" text,
	"lint_notes" text,
	"superseded_at" timestamp with time zone,
	"forget_reason" text
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_page_links" ADD CONSTRAINT "memory_page_links_from_page_id_memory_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."memory_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_page_links" ADD CONSTRAINT "memory_page_links_to_page_id_memory_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."memory_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pages" ADD CONSTRAINT "memory_pages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pages" ADD CONSTRAINT "memory_pages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pages" ADD CONSTRAINT "memory_pages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_entries_company_idx" ON "memory_entries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_entries_agent_idx" ON "memory_entries" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_entries_session_idx" ON "memory_entries" USING btree ("company_id","session_kind","session_id");--> statement-breakpoint
CREATE INDEX "memory_entries_user_idx" ON "memory_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_page_links_to_idx" ON "memory_page_links" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "memory_pages_company_idx" ON "memory_pages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_pages_agent_idx" ON "memory_pages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_pages_user_idx" ON "memory_pages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_pages_session_idx" ON "memory_pages" USING btree ("company_id","session_kind","session_id");--> statement-breakpoint
-- Partial HNSW indexes — only embedded, non-superseded rows.
-- Hand-edited because drizzle-kit doesn't emit USING hnsw or
-- partial WHERE clauses on indexes. Wrapped in DO blocks so the
-- migration succeeds on environments without pgvector (tests skip
-- explicitly when the extension is missing).
DO $$ BEGIN
  CREATE INDEX "memory_entries_embedding_hnsw" ON "memory_entries"
    USING hnsw ("embedding" vector_cosine_ops)
    WHERE "embedding" IS NOT NULL AND "superseded_at" IS NULL;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "memory_pages_embedding_hnsw" ON "memory_pages"
    USING hnsw ("embedding" vector_cosine_ops)
    WHERE "embedding" IS NOT NULL AND "superseded_at" IS NULL;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;--> statement-breakpoint
-- Partial unique on (scope, slug) — at most one active page per
-- scope per slug. NULL columns coalesced via the explicit form so
-- multiple agents in the same company can each have a 'foo' page.
CREATE UNIQUE INDEX "memory_pages_slug_active_uniq" ON "memory_pages"
  ("company_id", COALESCE("agent_id"::text, ''),
   COALESCE("user_id", ''), COALESCE("session_id"::text, ''), "slug")
  WHERE "superseded_at" IS NULL;