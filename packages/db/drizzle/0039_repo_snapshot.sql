CREATE TABLE "repo_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"ref" text NOT NULL,
	"tree_sha" text NOT NULL,
	"tree_key" text NOT NULL,
	"tree_truncated" boolean DEFAULT false NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"languages" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_snapshot_repo_sha_unique" UNIQUE("repo_id","commit_sha")
);
--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "repo_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "jira_board" ADD COLUMN "source_repo_id" text;--> statement-breakpoint
ALTER TABLE "repo_snapshot" ADD CONSTRAINT "repo_snapshot_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_snapshot_repo_created_at_idx" ON "repo_snapshot" USING btree ("repo_id","created_at");--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_repo_snapshot_id_repo_snapshot_id_fk" FOREIGN KEY ("repo_snapshot_id") REFERENCES "public"."repo_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board" ADD CONSTRAINT "jira_board_source_repo_id_github_repo_id_fk" FOREIGN KEY ("source_repo_id") REFERENCES "public"."github_repo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_proposal_repo_snapshot_id_idx" ON "bounty_proposal" USING btree ("repo_snapshot_id");--> statement-breakpoint
CREATE INDEX "jira_board_source_repo_id_idx" ON "jira_board" USING btree ("source_repo_id");