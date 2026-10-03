CREATE TABLE "sandbox_ticket" (
	"sandbox_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	CONSTRAINT "sandbox_ticket_sandbox_id_ticket_id_pk" PRIMARY KEY("sandbox_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"issue_type" text DEFAULT 'Task' NOT NULL,
	"priority" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_truncated" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"repo_id" text,
	"created_by" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "ticket_number_check" CHECK ("ticket"."number" > 0),
	CONSTRAINT "ticket_title_check" CHECK (char_length("ticket"."title") between 1 and 255),
	CONSTRAINT "ticket_origin_check" CHECK ("ticket"."origin" in ('manual', 'jira')),
	CONSTRAINT "ticket_revision_check" CHECK ("ticket"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_kind_check";--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_source_check";--> statement-breakpoint
DROP INDEX "bounty_proposal_live_unique";--> statement-breakpoint
DROP INDEX "bounty_run_board_active_unique";--> statement-breakpoint
ALTER TABLE "bounty_run" ALTER COLUMN "board_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD COLUMN "ticket_id" text;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD COLUMN "ticket_id" text;--> statement-breakpoint
ALTER TABLE "jira_issue" ADD COLUMN "ticket_id" text;--> statement-breakpoint
-- Backfill: every Jira issue a run imported becomes a ticket, and what
-- pointed at the issue points at the ticket.
--
-- Hand-written because drizzle-kit generates schema, not data. The two
-- `ticket_id` columns above are added nullable, filled here, and only then
-- made NOT NULL, which is what the schema declares.
--
-- Until now an issue's text lived only in Jira, so there is little to copy.
-- The title is the one the issue's latest run planned it under, or its key
-- when no plan named it; the description is empty and the type is the
-- default. Whatever next reads the issue from Jira (a run, or opening one of
-- its proposals) refreshes the ticket. An organization's tickets are
-- numbered by when Jira created the issues, so its oldest is T-1.
--
-- The new ids are minted on the pointers first, so the tickets can be
-- inserted from them in one statement with no mapping table.
UPDATE "jira_issue" SET "ticket_id" = 'tkt_' || gen_random_uuid() WHERE "ticket_id" IS NULL;--> statement-breakpoint
INSERT INTO "ticket" ("id", "organization_id", "number", "title", "origin", "created_at", "updated_at")
SELECT
  i."ticket_id",
  i."organization_id",
  row_number() OVER (
    PARTITION BY i."organization_id"
    ORDER BY i."remote_created_at", i."id"
  ),
  left(coalesce(nullif(btrim(planned.summary), ''), i."key"), 255),
  'jira',
  i."last_seen_at",
  now()
FROM "jira_issue" i
LEFT JOIN LATERAL (
  SELECT entry->>'summary' AS summary
  FROM "bounty_run" r
  CROSS JOIN LATERAL jsonb_array_elements(r."planned") AS entry
  WHERE r."board_id" = i."board_id"
    AND entry->>'externalIssueId' = i."external_id"
  ORDER BY r."created_at" DESC
  LIMIT 1
) AS planned ON true;--> statement-breakpoint
ALTER TABLE "jira_issue" ALTER COLUMN "ticket_id" SET NOT NULL;--> statement-breakpoint
UPDATE "bounty_proposal" p
SET "ticket_id" = i."ticket_id"
FROM "jira_issue" i
WHERE i."id" = p."jira_issue_id";--> statement-breakpoint
ALTER TABLE "bounty_proposal" ALTER COLUMN "ticket_id" SET NOT NULL;--> statement-breakpoint
-- A re-price or spec change names its proposal's ticket, as new ones do.
UPDATE "bounty_run" r
SET "ticket_id" = p."ticket_id"
FROM "bounty_proposal" p
WHERE r."kind" in ('reprice', 'respec')
  AND p."id" = r."source_proposal_id";--> statement-breakpoint
-- A sandbox's Jira links become ticket links; 0044 drops the old table.
INSERT INTO "sandbox_ticket" ("sandbox_id", "ticket_id")
SELECT s."sandbox_id", i."ticket_id"
FROM "sandbox_jira_issue" s
JOIN "jira_issue" i ON i."id" = s."jira_issue_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "sandbox_ticket" ADD CONSTRAINT "sandbox_ticket_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_ticket" ADD CONSTRAINT "sandbox_ticket_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_ticket_ticket_id_idx" ON "sandbox_ticket" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_organization_created_idx" ON "ticket" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_repo_id_idx" ON "ticket" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_proposal_ticket_id_idx" ON "bounty_proposal" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_ticket_active_unique" ON "bounty_run" USING btree ("ticket_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" = 'ticket';--> statement-breakpoint
CREATE INDEX "bounty_run_ticket_id_idx" ON "bounty_run" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_proposal_live_unique" ON "bounty_proposal" USING btree ("ticket_id") WHERE "bounty_proposal"."status" in ('proposed', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_board_active_unique" ON "bounty_run" USING btree ("board_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" not in ('issue', 'respec', 'ticket');--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_ticket_unique" UNIQUE("ticket_id");--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_scope_check" CHECK (("bounty_run"."kind" not in ('backlog', 'issue') OR "bounty_run"."board_id" IS NOT NULL) AND ("bounty_run"."kind" <> 'ticket' OR "bounty_run"."ticket_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_kind_check" CHECK ("bounty_run"."kind" in ('backlog', 'reprice', 'issue', 'respec', 'ticket'));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_source_check" CHECK (("bounty_run"."kind" in ('backlog', 'issue', 'ticket') AND "bounty_run"."source_proposal_id" IS NULL AND "bounty_run"."source_revision" IS NULL) OR ("bounty_run"."kind" in ('reprice', 'respec') AND "bounty_run"."source_revision" > 0));