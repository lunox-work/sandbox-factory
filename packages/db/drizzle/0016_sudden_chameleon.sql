CREATE TABLE "jira_issue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"board_id" text NOT NULL,
	"external_id" text NOT NULL,
	"key" text NOT NULL,
	"status_category" text NOT NULL,
	"remote_created_at" timestamp with time zone NOT NULL,
	"remote_updated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "jira_issue_board_external_unique" UNIQUE("board_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_board_id_jira_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jira_issue_organization_id_idx" ON "jira_issue" USING btree ("organization_id");