ALTER TABLE "sandbox_version_source" DROP CONSTRAINT "sandbox_version_source_approved_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD CONSTRAINT "sandbox_version_source_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_repo_due_for_sync_idx" ON "github_repo" USING btree ("last_synced_at" asc nulls first) WHERE "github_repo"."sync_status" <> 'gone';--> statement-breakpoint
CREATE INDEX "sandbox_source_repo_idx" ON "sandbox_source" USING btree ("source_repo_id");--> statement-breakpoint
CREATE INDEX "sandbox_version_source_snapshot_idx" ON "sandbox_version_source" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "sandbox_version_source_slice_run_idx" ON "sandbox_version_source" USING btree ("slice_run_id");--> statement-breakpoint
CREATE INDEX "sandbox_version_source_starter_run_idx" ON "sandbox_version_source" USING btree ("starter_run_id");--> statement-breakpoint
CREATE INDEX "sandbox_version_source_build_run_idx" ON "sandbox_version_source" USING btree ("build_run_id");--> statement-breakpoint
ALTER TABLE "jira_issue" DROP COLUMN "status_category";--> statement-breakpoint
ALTER TABLE "jira_issue" DROP COLUMN "remote_created_at";--> statement-breakpoint
ALTER TABLE "jira_issue" DROP COLUMN "remote_updated_at";--> statement-breakpoint
ALTER TABLE "jira_issue" DROP COLUMN "last_seen_at";