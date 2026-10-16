CREATE TABLE "workspace_setting" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"prepare_sandboxes" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD COLUMN "prepared_run_id" text;--> statement-breakpoint
ALTER TABLE "workspace_setting" ADD CONSTRAINT "workspace_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_setting" ADD CONSTRAINT "workspace_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_prepared_run_id_analysis_run_id_fk" FOREIGN KEY ("prepared_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;