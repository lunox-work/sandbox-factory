ALTER TABLE "sandbox_source" ADD COLUMN "cut_requested_by" text;--> statement-breakpoint
ALTER TABLE "sandbox_source" ADD COLUMN "cut_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_source" ADD CONSTRAINT "sandbox_source_cut_requested_by_user_id_fk" FOREIGN KEY ("cut_requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;