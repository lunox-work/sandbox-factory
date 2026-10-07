CREATE TABLE "bounty_context" (
	"bounty_id" text NOT NULL,
	"source" text NOT NULL,
	"version" integer NOT NULL,
	"ref" text NOT NULL,
	"ref_id" text NOT NULL,
	"revision" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"synced_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_context_bounty_id_source_version_pk" PRIMARY KEY("bounty_id","source","version"),
	CONSTRAINT "bounty_context_source_check" CHECK ("bounty_context"."source" in ('jira', 'github')),
	CONSTRAINT "bounty_context_version_check" CHECK ("bounty_context"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "jira_context_version" integer;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "github_context_version" integer;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD COLUMN "jira_context_version" integer;--> statement-breakpoint
ALTER TABLE "sandbox_version_source" ADD COLUMN "github_context_version" integer;--> statement-breakpoint
ALTER TABLE "bounty_context" ADD CONSTRAINT "bounty_context_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_context" ADD CONSTRAINT "bounty_context_synced_by_user_id_fk" FOREIGN KEY ("synced_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;