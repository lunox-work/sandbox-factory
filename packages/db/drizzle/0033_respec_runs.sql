ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_kind_check";--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_source_check";--> statement-breakpoint
DROP INDEX "bounty_run_board_active_unique";--> statement-breakpoint
ALTER TABLE "bounty_run" ADD COLUMN "respec" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_proposal_active_unique" ON "bounty_run" USING btree ("source_proposal_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" in ('reprice', 'respec');--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_board_active_unique" ON "bounty_run" USING btree ("board_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" not in ('issue', 'respec');--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_respec_check" CHECK (("bounty_run"."kind" = 'respec') = ("bounty_run"."respec" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_kind_check" CHECK ("bounty_run"."kind" in ('backlog', 'reprice', 'issue', 'respec'));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_source_check" CHECK (("bounty_run"."kind" in ('backlog', 'issue') AND "bounty_run"."source_proposal_id" IS NULL AND "bounty_run"."source_revision" IS NULL) OR ("bounty_run"."kind" in ('reprice', 'respec') AND "bounty_run"."source_revision" > 0));