ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_kind_check";--> statement-breakpoint
DROP INDEX "bounty_run_board_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_board_active_unique" ON "bounty_run" USING btree ("board_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" <> 'issue';--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_kind_check" CHECK ("bounty_run"."kind" in ('backlog', 'reprice', 'issue'));