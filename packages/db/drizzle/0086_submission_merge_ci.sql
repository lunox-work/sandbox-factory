ALTER TABLE "submission_merge" ADD COLUMN "repo_id" text;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "merge_when" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "pull_request_state" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "ci_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "ci_summary" jsonb;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "ci_head_sha" text;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "ci_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "merged_commit_sha" text;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD COLUMN "merge_error" text;--> statement-breakpoint
ALTER TABLE "submission_merge" ADD CONSTRAINT "submission_merge_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_merge_open_repo_idx" ON "submission_merge" USING btree ("repo_id") WHERE "submission_merge"."pull_request_state" = 'open' AND "submission_merge"."status" = 'opened';