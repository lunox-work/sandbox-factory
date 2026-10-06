ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_sized_by_check";--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "rubric" jsonb;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_rubric_check" CHECK ("bounty_proposal"."sized_by" <> 'rubric' or "bounty_proposal"."rubric" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_sized_by_check" CHECK ("bounty_proposal"."sized_by" in ('model', 'rubric', 'reviewer'));