CREATE TABLE "github_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"pr_url" text,
	"outcome_id" uuid,
	"signature_valid" boolean NOT NULL,
	"result" text NOT NULL,
	"raw_body_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_required_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_phases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "github_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "suggested_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_templates" ADD CONSTRAINT "plan_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_templates" ADD CONSTRAINT "plan_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_webhook_deliveries_uniq" ON "github_webhook_deliveries" USING btree ("company_id","delivery_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_company_idx" ON "github_webhook_deliveries" USING btree ("company_id","received_at");
-- Active templates per company (excluding archived).
CREATE INDEX "plan_templates_company_idx"
  ON "plan_templates" ("company_id") WHERE "archived_at" IS NULL;

-- Unique active template name per company.
CREATE UNIQUE INDEX "plan_templates_company_name_uniq"
  ON "plan_templates" ("company_id", "name") WHERE "archived_at" IS NULL;