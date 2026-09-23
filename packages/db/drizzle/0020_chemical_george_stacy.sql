CREATE TABLE "bounty_writeback" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text DEFAULT 'comment' NOT NULL,
	"payload" jsonb NOT NULL,
	"jira_comment_id" text,
	"error_code" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"comment_attempted_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_writeback_proposal_revision_kind_unique" UNIQUE("proposal_id","proposal_revision","kind"),
	CONSTRAINT "bounty_writeback_kind_check" CHECK ("bounty_writeback"."kind" in ('approved', 'rejected', 'superseded')),
	CONSTRAINT "bounty_writeback_status_check" CHECK ("bounty_writeback"."status" in ('pending', 'running', 'done', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "bounty_writeback_step_check" CHECK ("bounty_writeback"."step" in ('comment', 'label'))
);
--> statement-breakpoint
ALTER TABLE "jira_connection" ADD COLUMN "resource_scopes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_connection" ADD COLUMN "credential_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bounty_writeback" ADD CONSTRAINT "bounty_writeback_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_writeback" ADD CONSTRAINT "bounty_writeback_proposal_id_bounty_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."bounty_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_writeback" ADD CONSTRAINT "bounty_writeback_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_writeback_proposal_running_unique" ON "bounty_writeback" USING btree ("proposal_id") WHERE "bounty_writeback"."status" = 'running';--> statement-breakpoint
CREATE INDEX "bounty_writeback_organization_id_idx" ON "bounty_writeback" USING btree ("organization_id");