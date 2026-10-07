ALTER TABLE "bounty" ADD COLUMN "approved_version" integer;--> statement-breakpoint
ALTER TABLE "bounty" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "bounty" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_approved_version_check" CHECK (("bounty"."approved_version" IS NULL AND "bounty"."approved_at" IS NULL) OR ("bounty"."approved_version" BETWEEN 1 AND "bounty"."version" AND "bounty"."approved_at" IS NOT NULL));