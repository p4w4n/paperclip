CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"required_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_meta" jsonb,
	"verified_at" timestamp with time zone,
	"verified_by_kind" text,
	"verified_by_id" uuid,
	"reverted_at" timestamp with time zone,
	"reverted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "outcome_signal_secret" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "required_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "required_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "default_required_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outcomes_target_idx" ON "outcomes" USING btree ("company_id","target_kind","target_id");
-- Hand-edited partial indexes (drizzle-kit doesn't emit partial WHERE):
-- Pending-only partial index, used by the gate-check predicate.
CREATE INDEX "outcomes_pending_idx"
  ON "outcomes" ("company_id", "target_kind", "target_id")
  WHERE "status" = 'pending';

-- One slot per (target, kind, name); name comes from required_meta->>'name'.
CREATE UNIQUE INDEX "outcomes_contract_uniq"
  ON "outcomes" ("company_id", "target_kind", "target_id", "kind", ((required_meta->>'name')))
  WHERE "status" IN ('pending', 'verified');

-- For external_signal Idempotency-Key dedup.
CREATE UNIQUE INDEX "outcomes_signal_idem_uniq"
  ON "outcomes" ("company_id", "id", ((verified_meta->>'idempotency_key')))
  WHERE "kind" = 'external_signal' AND verified_meta->>'idempotency_key' IS NOT NULL;
