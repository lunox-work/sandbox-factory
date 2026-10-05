ALTER TABLE "bounty" ADD COLUMN "stack" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_repo" ADD COLUMN "stack" jsonb;--> statement-breakpoint
ALTER TABLE "github_repo" ADD COLUMN "stack_commit_sha" text;--> statement-breakpoint
ALTER TABLE "github_repo" ADD COLUMN "stack_version" integer;