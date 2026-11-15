CREATE TABLE "bounty_posted_spec" (
	"bounty_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"document" text NOT NULL,
	"draft" jsonb NOT NULL,
	"source" text NOT NULL,
	"spec_hash" text NOT NULL,
	"spec_hash_version" integer NOT NULL,
	"confirmed_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_posted_spec_hash_check" CHECK (length("bounty_posted_spec"."spec_hash") = 64 AND "bounty_posted_spec"."spec_hash_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_spec" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "decision_confirmation" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "bounty_posted_spec" ADD CONSTRAINT "bounty_posted_spec_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_posted_spec" ADD CONSTRAINT "bounty_posted_spec_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_posted_spec" ADD CONSTRAINT "bounty_posted_spec_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_posted_spec" ADD CONSTRAINT "bounty_posted_spec_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_posted_spec_organization_id_idx" ON "bounty_posted_spec" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "decision_confirmation" ADD CONSTRAINT "decision_confirmation_via_check" CHECK ("decision_confirmation"."via" IS NULL OR "decision_confirmation"."via" in ('duediligence'));