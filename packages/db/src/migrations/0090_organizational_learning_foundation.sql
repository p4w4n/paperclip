CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"evidence_run_ids" text[] NOT NULL,
	"last_evidenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_name_pk" PRIMARY KEY("agent_id","skill_name")
);
--> statement-breakpoint
CREATE TABLE "decision_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"condition_summary" text NOT NULL,
	"typical_choice" text NOT NULL,
	"exemplar_decision_ids" text[] NOT NULL,
	"cluster_size" integer NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "outcome_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pattern_name" text NOT NULL,
	"pattern_description" text,
	"exemplar_run_ids" text[] NOT NULL,
	"cluster_size" integer NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"promoted_to_playbook_id" uuid,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "playbook_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"parent_revision_id" uuid,
	"content_markdown" text NOT NULL,
	"change_summary" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"current_revision_id" uuid,
	"current_revision_number" integer DEFAULT 1 NOT NULL,
	"applicability_conditions" jsonb,
	"source_run_ids" text[],
	"source_plan_ids" text[],
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_patterns" ADD CONSTRAINT "decision_patterns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_patterns" ADD CONSTRAINT "decision_patterns_superseded_by_id_decision_patterns_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."decision_patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_patterns" ADD CONSTRAINT "outcome_patterns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_patterns" ADD CONSTRAINT "outcome_patterns_promoted_to_playbook_id_playbooks_id_fk" FOREIGN KEY ("promoted_to_playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_revisions" ADD CONSTRAINT "playbook_revisions_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_revisions" ADD CONSTRAINT "playbook_revisions_parent_revision_id_playbook_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."playbook_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_revisions" ADD CONSTRAINT "playbook_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_company_idx" ON "agent_skills" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "decision_patterns_company_idx" ON "decision_patterns" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "outcome_patterns_company_idx" ON "outcome_patterns" USING btree ("company_id","derived_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_revisions_pb_revnum_uniq" ON "playbook_revisions" USING btree ("playbook_id","revision_number");--> statement-breakpoint
CREATE INDEX "playbooks_company_status_idx" ON "playbooks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "playbooks_agent_idx" ON "playbooks" USING btree ("agent_id");--> statement-breakpoint
-- Partial unique on (company_id, agent_id?, slug) WHERE status='active'.
-- Hand-edited; drizzle-kit doesn't emit partial-WHERE indexes.
CREATE UNIQUE INDEX "playbooks_slug_active_uniq" ON "playbooks"
  ("company_id", COALESCE("agent_id"::text, ''), "slug")
  WHERE "status" = 'active';