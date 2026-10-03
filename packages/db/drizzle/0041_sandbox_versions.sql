CREATE TABLE "sandbox" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"public_repo_id" text,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sandbox_jira_issue" (
	"sandbox_id" text NOT NULL,
	"jira_issue_id" text NOT NULL,
	CONSTRAINT "sandbox_jira_issue_sandbox_id_jira_issue_id_pk" PRIMARY KEY("sandbox_id","jira_issue_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_source" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"source_repo_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_version" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"spec_summary" text NOT NULL,
	"complexity" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"test_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public_base_commit_sha" text,
	"readme" text,
	"languages" jsonb,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_version_sandbox_version_unique" UNIQUE("sandbox_id","version")
);
--> statement-breakpoint
CREATE TABLE "sandbox_version_source" (
	"sandbox_version_id" text PRIMARY KEY NOT NULL,
	"source_snapshot_id" text NOT NULL,
	"slice_run_id" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"contract_sha256" text NOT NULL,
	"transform_config_sha256" text NOT NULL,
	"approved_task_sha256" text NOT NULL,
	"approved_task" jsonb NOT NULL,
	"alias_rules" jsonb NOT NULL,
	"dependency_choices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acceptance_tests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixtures" jsonb,
	"scope" jsonb NOT NULL,
	"harness_sha256" text,
	"toolchain_digest" text,
	"build_run_id" text,
	"round_trip_run_id" text,
	"disclosure_run_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_public_repo_id_github_repo_id_fk" FOREIGN KEY ("public_repo_id") REFERENCES "public"."github_repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jira_issue" ADD CONSTRAINT "sandbox_jira_issue_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jira_issue" ADD CONSTRAINT "sandbox_jira_issue_jira_issue_id_jira_issue_id_fk" FOREIGN KEY ("jira_issue_id") REFERENCES "public"."jira_issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_source" ADD CONSTRAINT "sandbox_source_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_source" ADD CONSTRAINT "sandbox_source_source_repo_id_github_repo_id_fk" FOREIGN KEY ("source_repo_id") REFERENCES "public"."github_repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version" ADD CONSTRAINT "sandbox_version_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_sandbox_version_id_sandbox_version_id_fk" FOREIGN KEY ("sandbox_version_id") REFERENCES "public"."sandbox_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_source_snapshot_id_repo_snapshot_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."repo_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_slice_run_id_analysis_run_id_fk" FOREIGN KEY ("slice_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_build_run_id_analysis_run_id_fk" FOREIGN KEY ("build_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_round_trip_run_id_analysis_run_id_fk" FOREIGN KEY ("round_trip_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_disclosure_run_id_analysis_run_id_fk" FOREIGN KEY ("disclosure_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_organization_id_idx" ON "sandbox" USING btree ("organization_id");