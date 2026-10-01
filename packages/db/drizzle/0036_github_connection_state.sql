ALTER TABLE "github_connection" ADD COLUMN "uninstalled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "github_grant_user_id_idx" ON "github_grant" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_id_organization_unique" UNIQUE("id","organization_id");