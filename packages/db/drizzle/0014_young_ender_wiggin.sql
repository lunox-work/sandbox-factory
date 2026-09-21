CREATE TABLE "jira_board" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"board_type" text NOT NULL,
	"project_key" text,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"writeback_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jira_board_connection_external_unique" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "jira_board" ADD CONSTRAINT "jira_board_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board" ADD CONSTRAINT "jira_board_connection_id_jira_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jira_board_organization_id_idx" ON "jira_board" USING btree ("organization_id");