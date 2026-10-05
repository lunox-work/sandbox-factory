ALTER TABLE "bounty" DROP CONSTRAINT "bounty_organization_number_unique";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "bounty_number_check";--> statement-breakpoint
ALTER TABLE "bounty" DROP COLUMN "number";