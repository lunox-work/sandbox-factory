CREATE TABLE "jira_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cloud_id" text NOT NULL,
	"site_url" text NOT NULL,
	"site_name" text NOT NULL,
	"kind" text DEFAULT 'oauth' NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"key_id" text,
	"expires_at" timestamp with time zone,
	"scopes" text DEFAULT '' NOT NULL,
	"email" text,
	"healthy" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jira_connection_organization_site_unique" UNIQUE("organization_id","cloud_id")
);
--> statement-breakpoint
ALTER TABLE "jira_connection" ADD CONSTRAINT "jira_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jira_connection_organization_id_idx" ON "jira_connection" USING btree ("organization_id");