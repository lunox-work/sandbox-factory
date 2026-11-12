ALTER TABLE "bounty" DROP CONSTRAINT "bounty_origin_check";--> statement-breakpoint
ALTER TABLE "bounty" ADD COLUMN "source_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_source_url_unique" ON "bounty" USING btree ("organization_id","source_url") WHERE "bounty"."source_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_source_url_check" CHECK (("bounty"."origin" = 'github') = ("bounty"."source_url" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_origin_check" CHECK ("bounty"."origin" in ('manual', 'jira', 'github'));