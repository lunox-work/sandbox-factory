ALTER TABLE "bounty_profile" DROP CONSTRAINT "bounty_profile_status_check";--> statement-breakpoint
ALTER TABLE "bounty_profile" DROP CONSTRAINT "bounty_profile_ready_check";--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD COLUMN "slice_approved_by" text;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD COLUMN "slice_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_slice_approved_by_user_id_fk" FOREIGN KEY ("slice_approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_status_check" CHECK ("bounty_profile"."status" in ('queued', 'scoping', 'slicing', 'awaiting_approval', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "bounty_profile" ADD CONSTRAINT "bounty_profile_ready_check" CHECK (("bounty_profile"."status" in ('awaiting_approval', 'ready')) = ("bounty_profile"."profile" IS NOT NULL));