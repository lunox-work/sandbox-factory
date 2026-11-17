ALTER TABLE "api_token" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "secret_enc" text;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "key_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "api_token_default_unique" ON "api_token" USING btree ("organization_id","created_by") WHERE "api_token"."is_default" AND "api_token"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_default_secret_check" CHECK ("api_token"."is_default" = ("api_token"."secret_enc" IS NOT NULL));