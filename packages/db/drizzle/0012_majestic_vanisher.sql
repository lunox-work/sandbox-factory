-- Organizations: the second principal, beside `user`.
--
-- Three tables owned by Better Auth's organization plugin, plus one nullable
-- column on `session`. Purely additive: nothing existing changes shape, and
-- no backfill is needed, so this is safe to apply before the code that reads
-- it deploys — which is the order `cd.yml` uses.
--
-- Trimmed after generation. drizzle-kit has no snapshot for migrations 0007
-- to 0011 (they are hand-written SQL, and only 0000-0006 and this one left a
-- snapshot behind), so it diffed against 0006 and re-emitted four statements
-- that 0011 already performed: dropping `user_email_unique` and
-- `user_email_email_unique`, and creating the two `lower(email)` indexes.
-- Re-running them would fail on the first `DROP CONSTRAINT`. They are removed
-- here; the column work below is the whole of this migration.
--
-- `organization.slug` is the renameable public handle, unique and stored
-- lowercase by the plugin hooks in `apps/api/src/auth.ts`. `organization.id`
-- is permanent and is what every reference uses.

CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_organization_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A preference, not an authorisation input: `set null`, so deleting an
-- organization does not sign its members out of the whole product.
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- "Which organizations am I in", read on every page load.
CREATE INDEX "member_user_id_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
-- The invitee's inbox: `where email = $1 and status = 'pending'`.
CREATE INDEX "invitation_email_status_idx" ON "invitation" USING btree ("email","status");--> statement-breakpoint
-- The organization's own pending list, on its settings page.
CREATE INDEX "invitation_organization_id_idx" ON "invitation" USING btree ("organization_id");
