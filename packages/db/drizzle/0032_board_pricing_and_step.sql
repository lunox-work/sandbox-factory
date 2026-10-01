ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_complexity_check";--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "step" jsonb;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "step_version" text;--> statement-breakpoint
ALTER TABLE "jira_board" ADD COLUMN "pricing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_step_check" CHECK (("bounty_proposal"."step" IS NULL) = ("bounty_proposal"."step_version" IS NULL));--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_complexity_check" CHECK ("bounty_proposal"."complexity" in ('XS', 'XS+', 'S', 'S+', 'M', 'M+', 'L', 'L+', 'XL', 'unsized'));