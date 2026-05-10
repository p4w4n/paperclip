CREATE TABLE "plan_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"phase_id" uuid,
	"title" text NOT NULL,
	"options_json" jsonb NOT NULL,
	"chosen_option_id" text NOT NULL,
	"rationale_markdown" text,
	"decided_by_user_id" text,
	"decided_by_agent_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "plan_phase_dependencies" (
	"from_phase_id" uuid NOT NULL,
	"to_phase_id" uuid NOT NULL,
	CONSTRAINT "plan_phase_dependencies_from_phase_id_to_phase_id_pk" PRIMARY KEY("from_phase_id","to_phase_id")
);
--> statement-breakpoint
CREATE TABLE "plan_phase_runs" (
	"phase_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "plan_phase_runs_phase_id_run_id_pk" PRIMARY KEY("phase_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "plan_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"ordering" integer NOT NULL,
	"name" text NOT NULL,
	"description_markdown" text,
	"exit_criteria_markdown" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"assignee_agent_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_id" uuid,
	"reviewer_user_id" text,
	"reviewer_agent_id" uuid,
	"decision" text NOT NULL,
	"comment_markdown" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"parent_revision_id" uuid,
	"content_markdown" text NOT NULL,
	"change_summary" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_revision_id" uuid,
	"current_revision_number" integer DEFAULT 1 NOT NULL,
	"approval_policy" text DEFAULT 'one_human' NOT NULL,
	"phase_advance_policy" text DEFAULT 'auto' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "plan_decisions" ADD CONSTRAINT "plan_decisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_decisions" ADD CONSTRAINT "plan_decisions_phase_id_plan_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."plan_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_decisions" ADD CONSTRAINT "plan_decisions_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_decisions" ADD CONSTRAINT "plan_decisions_superseded_by_id_plan_decisions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."plan_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phase_dependencies" ADD CONSTRAINT "plan_phase_dependencies_from_phase_id_plan_phases_id_fk" FOREIGN KEY ("from_phase_id") REFERENCES "public"."plan_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phase_dependencies" ADD CONSTRAINT "plan_phase_dependencies_to_phase_id_plan_phases_id_fk" FOREIGN KEY ("to_phase_id") REFERENCES "public"."plan_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phase_runs" ADD CONSTRAINT "plan_phase_runs_phase_id_plan_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."plan_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phase_runs" ADD CONSTRAINT "plan_phase_runs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phases" ADD CONSTRAINT "plan_phases_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_phases" ADD CONSTRAINT "plan_phases_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_revision_id_plan_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_parent_revision_id_plan_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_phases_plan_idx" ON "plan_phases" USING btree ("plan_id","ordering");--> statement-breakpoint
CREATE INDEX "plan_reviews_plan_idx" ON "plan_reviews" USING btree ("plan_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "plan_revisions_plan_revnum_uniq" ON "plan_revisions" USING btree ("plan_id","revision_number");--> statement-breakpoint
CREATE INDEX "plans_company_status_idx" ON "plans" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "plans_issue_idx" ON "plans" USING btree ("issue_id");