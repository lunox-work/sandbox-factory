ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_status_check";--> statement-breakpoint
ALTER TABLE "bounty_writeback" DROP CONSTRAINT "bounty_writeback_kind_check";--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_replaces_proposal_id_fkey";
--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP COLUMN "replaces_proposal_id";--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_status_check" CHECK ("bounty_proposal"."status" in ('proposed', 'approved'));--> statement-breakpoint
ALTER TABLE "bounty_writeback" ADD CONSTRAINT "bounty_writeback_kind_check" CHECK ("bounty_writeback"."kind" in ('approved', 'withdrawn'));