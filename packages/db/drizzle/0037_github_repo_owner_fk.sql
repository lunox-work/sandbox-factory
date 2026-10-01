ALTER TABLE "github_repo" DROP CONSTRAINT "github_repo_connection_id_github_connection_id_fk";
--> statement-breakpoint
ALTER TABLE "github_repo" ADD CONSTRAINT "github_repo_connection_owner_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."github_connection"("id","organization_id") ON DELETE cascade ON UPDATE no action;