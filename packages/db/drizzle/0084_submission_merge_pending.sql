ALTER TABLE "submission_merge" ALTER COLUMN "commit_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ALTER COLUMN "pull_request_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ALTER COLUMN "pull_request_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "status" text DEFAULT 'opened' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD CONSTRAINT "submission_merge_status_check" CHECK ("submission_merge"."status" = 'pending' OR ("submission_merge"."status" = 'opened' AND "submission_merge"."commit_sha" IS NOT NULL AND "submission_merge"."pull_request_number" IS NOT NULL AND "submission_merge"."pull_request_url" IS NOT NULL));