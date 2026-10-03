CREATE TABLE "bounty_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"spec_revision" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"snapshot_id" text,
	"ticket" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"run_error_code" text,
	"scope_run_id" text,
	"slice_run_id" text,
	"profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_profile_proposal_revision_unique" UNIQUE("proposal_id","spec_revision"),
	CONSTRAINT "bounty_profile_status_check" CHECK ("bounty_profile"."status" in ('queued', 'scoping', 'slicing', 'ready', 'failed')),
	CONSTRAINT "bounty_profile_ready_check" CHECK (("bounty_profile"."status" = 'ready') = ("bounty_profile"."profile" IS NOT NULL)),
	CONSTRAINT "bounty_profile_failed_check" CHECK (("bounty_profile"."status" = 'failed') = ("bounty_profile"."error_code" IS NOT NULL)),
	CONSTRAINT "bounty_profile_revision_check" CHECK ("bounty_profile"."spec_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_proposal_id_bounty_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_snapshot_id_repo_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."repo_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_scope_run_id_analysis_run_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_slice_run_id_analysis_run_id_fk" FOREIGN KEY ("slice_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_profile_organization_id_idx" ON "bounty_profile" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bounty_profile_status_updated_at_idx" ON "bounty_profile" USING btree ("status","updated_at");