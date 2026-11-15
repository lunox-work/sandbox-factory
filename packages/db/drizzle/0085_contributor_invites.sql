CREATE TABLE "contributor_assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sandbox_version_id" text NOT NULL,
	"user_id" text NOT NULL,
	"invite_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contributor_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sandbox_version_id" text NOT NULL,
	"created_by" text,
	"email_hint" text,
	"label" text,
	"token_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_claims" integer DEFAULT 1 NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributor_invite_token_unique" UNIQUE("token_sha256"),
	CONSTRAINT "contributor_invite_token_hash_check" CHECK (length("contributor_invite"."token_sha256") = 64),
	CONSTRAINT "contributor_invite_claims_check" CHECK ("contributor_invite"."max_claims" >= 1 AND "contributor_invite"."claims" >= 0 AND "contributor_invite"."claims" <= "contributor_invite"."max_claims")
);
--> statement-breakpoint
ALTER TABLE "submission" DROP CONSTRAINT "submission_version_patch_unique";--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "assignment_id" text;--> statement-breakpoint
ALTER TABLE "contributor_assignment" ADD CONSTRAINT "contributor_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_assignment" ADD CONSTRAINT "contributor_assignment_sandbox_version_id_sandbox_version_id_fk" FOREIGN KEY ("sandbox_version_id") REFERENCES "public"."sandbox_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_assignment" ADD CONSTRAINT "contributor_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_assignment" ADD CONSTRAINT "contributor_assignment_invite_id_contributor_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."contributor_invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invite" ADD CONSTRAINT "contributor_invite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invite" ADD CONSTRAINT "contributor_invite_sandbox_version_id_sandbox_version_id_fk" FOREIGN KEY ("sandbox_version_id") REFERENCES "public"."sandbox_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invite" ADD CONSTRAINT "contributor_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_invite" ADD CONSTRAINT "contributor_invite_claimed_by_user_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contributor_assignment_live_unique" ON "contributor_assignment" USING btree ("sandbox_version_id","user_id") WHERE "contributor_assignment"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contributor_assignment_user_idx" ON "contributor_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contributor_assignment_version_idx" ON "contributor_assignment" USING btree ("organization_id","sandbox_version_id");--> statement-breakpoint
CREATE INDEX "contributor_invite_version_idx" ON "contributor_invite" USING btree ("organization_id","sandbox_version_id");--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_assignment_id_contributor_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."contributor_assignment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_assignment_first_unique" ON "submission" USING btree ("assignment_id") WHERE "submission"."assignment_id" IS NOT NULL AND "submission"."retry_of" IS NULL;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_version_patch_unique" UNIQUE NULLS NOT DISTINCT("sandbox_version_id","patch_sha256","submitted_by");