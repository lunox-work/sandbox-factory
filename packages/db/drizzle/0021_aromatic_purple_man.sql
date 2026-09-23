ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_model_complexity_check";--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_complexity_check";--> statement-breakpoint
ALTER TABLE "rate_card" DROP CONSTRAINT "rate_card_amounts_check";--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "xs_minor" bigint;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_model_complexity_check" CHECK ("bounty_proposal"."model_complexity" in ('XS', 'S', 'M', 'L', 'XL', 'unsized'));--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_complexity_check" CHECK ("bounty_proposal"."complexity" in ('XS', 'S', 'M', 'L', 'XL', 'unsized'));--> statement-breakpoint
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_amounts_check" CHECK (coalesce("rate_card"."xs_minor", "rate_card"."s_minor") > 0 AND coalesce("rate_card"."xs_minor", "rate_card"."s_minor") <= "rate_card"."s_minor" AND "rate_card"."s_minor" <= "rate_card"."m_minor" AND "rate_card"."m_minor" <= "rate_card"."l_minor" AND "rate_card"."l_minor" <= "rate_card"."xl_minor" AND "rate_card"."xl_minor" <= 9007199254740991);