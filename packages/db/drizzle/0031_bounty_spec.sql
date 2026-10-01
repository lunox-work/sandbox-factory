CREATE TABLE "bounty_spec" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"revision" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"spec_hash_version" integer NOT NULL,
	"draft" jsonb NOT NULL,
	"origin" text NOT NULL,
	"instruction" text,
	"created_by" text,
	"run_id" text,
	"actual_model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_spec_proposal_revision_unique" UNIQUE("proposal_id","revision"),
	CONSTRAINT "bounty_spec_revision_check" CHECK ("bounty_spec"."revision" > 0),
	CONSTRAINT "bounty_spec_origin_check" CHECK ("bounty_spec"."origin" in ('draft', 'expand', 'trim', 'answer')),
	CONSTRAINT "bounty_spec_hash_check" CHECK (length("bounty_spec"."spec_hash") = 64 AND "bounty_spec"."spec_hash_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "spec_revision" integer;--> statement-breakpoint
ALTER TABLE "bounty_spec" ADD CONSTRAINT "bounty_spec_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_spec" ADD CONSTRAINT "bounty_spec_proposal_id_bounty_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_spec" ADD CONSTRAINT "bounty_spec_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_spec" ADD CONSTRAINT "bounty_spec_run_id_bounty_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bounty_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_spec_organization_id_idx" ON "bounty_spec" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_spec_revision_check" CHECK ("bounty_proposal"."spec_revision" IS NULL OR "bounty_proposal"."spec_revision" > 0);