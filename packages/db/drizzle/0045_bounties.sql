CREATE TABLE "submission" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sandbox_version_id" text NOT NULL,
	"submitted_by" text,
	"patch_key" text NOT NULL,
	"patch_sha256" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_version_patch_unique" UNIQUE("sandbox_version_id","patch_sha256"),
	CONSTRAINT "submission_status_check" CHECK ("submission"."status" in ('queued', 'running', 'passed', 'failed', 'errored')),
	CONSTRAINT "submission_result_check" CHECK (("submission"."status" in ('passed', 'failed')) = ("submission"."result" IS NOT NULL)),
	CONSTRAINT "submission_patch_hash_check" CHECK (length("submission"."patch_sha256") = 64)
);
--> statement-breakpoint
ALTER TABLE "ticket" RENAME TO "bounty";--> statement-breakpoint
ALTER TABLE "bounty_profile" RENAME COLUMN "ticket" TO "bounty";--> statement-breakpoint
ALTER TABLE "bounty_proposal" RENAME COLUMN "ticket_id" TO "bounty_id";--> statement-breakpoint
ALTER TABLE "bounty_run" RENAME COLUMN "ticket_id" TO "bounty_id";--> statement-breakpoint
ALTER TABLE "jira_issue" RENAME COLUMN "ticket_id" TO "bounty_id";--> statement-breakpoint
-- Backfill: a sandbox belongs to one bounty now, where it used to link any
-- number of tickets (as bounties were called) through "sandbox_ticket".
--
-- Hand-written because drizzle-kit generates schema, not data. The column
-- is added nullable and filled here, and only then made NOT NULL, which is
-- what the schema declares; the link table goes after it has been read.
--
-- Each ticket goes to the oldest sandbox that linked it, and each sandbox
-- takes the lowest-numbered ticket it was given. A sandbox left with none,
-- because it linked nothing or lost every link to an older sandbox, gets a
-- bounty of its own, titled after its newest version, numbered after the
-- organization's highest. No sandbox is deleted, and every ticket keeps
-- whatever else pointed at it.
ALTER TABLE "sandbox" ADD COLUMN "bounty_id" text;--> statement-breakpoint
WITH "first_claim" AS (
  SELECT l."sandbox_id", l."ticket_id",
    row_number() OVER (PARTITION BY l."ticket_id" ORDER BY s."created_at", s."id") AS "rank"
  FROM "sandbox_ticket" l
  JOIN "sandbox" s ON s."id" = l."sandbox_id"
), "chosen" AS (
  SELECT c."sandbox_id", c."ticket_id",
    row_number() OVER (PARTITION BY c."sandbox_id" ORDER BY b."number", b."id") AS "rank"
  FROM "first_claim" c
  JOIN "bounty" b ON b."id" = c."ticket_id"
  WHERE c."rank" = 1
)
UPDATE "sandbox" SET "bounty_id" = c."ticket_id"
FROM "chosen" c
WHERE c."sandbox_id" = "sandbox"."id" AND c."rank" = 1;--> statement-breakpoint
UPDATE "sandbox" SET "bounty_id" = 'bty_' || gen_random_uuid() WHERE "bounty_id" IS NULL;--> statement-breakpoint
INSERT INTO "bounty" ("id", "organization_id", "number", "title", "origin", "created_at", "updated_at")
SELECT
  s."bounty_id",
  s."organization_id",
  coalesce((SELECT max(b."number") FROM "bounty" b WHERE b."organization_id" = s."organization_id"), 0)
    + row_number() OVER (PARTITION BY s."organization_id" ORDER BY s."created_at", s."id"),
  left(coalesce(
    (SELECT v."title" FROM "sandbox_version" v WHERE v."sandbox_id" = s."id" ORDER BY v."version" DESC LIMIT 1),
    'Sandbox ' || s."slug"
  ), 255),
  'manual',
  s."created_at",
  s."created_at"
FROM "sandbox" s
WHERE NOT EXISTS (SELECT 1 FROM "bounty" b WHERE b."id" = s."bounty_id");--> statement-breakpoint
ALTER TABLE "sandbox" ALTER COLUMN "bounty_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_ticket" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sandbox_ticket" CASCADE;--> statement-breakpoint
ALTER TABLE "jira_issue" DROP CONSTRAINT "jira_issue_ticket_unique";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_organization_number_unique";--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_kind_check";--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_scope_check";--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_source_check";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_number_check";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_title_check";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_origin_check";--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_revision_check";--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_ticket_id_ticket_id_fk";
--> statement-breakpoint
ALTER TABLE "bounty_run" DROP CONSTRAINT "bounty_run_ticket_id_ticket_id_fk";
--> statement-breakpoint
ALTER TABLE "jira_issue" DROP CONSTRAINT "jira_issue_ticket_id_ticket_id_fk";
--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_repo_id_github_repo_id_fk";
--> statement-breakpoint
ALTER TABLE "bounty" DROP CONSTRAINT "ticket_created_by_user_id_fk";
--> statement-breakpoint
DROP INDEX "bounty_proposal_ticket_id_idx";--> statement-breakpoint
DROP INDEX "bounty_run_ticket_active_unique";--> statement-breakpoint
DROP INDEX "bounty_run_ticket_id_idx";--> statement-breakpoint
DROP INDEX "ticket_organization_created_idx";--> statement-breakpoint
DROP INDEX "ticket_repo_id_idx";--> statement-breakpoint
DROP INDEX "bounty_proposal_live_unique";--> statement-breakpoint
DROP INDEX "bounty_run_board_active_unique";--> statement-breakpoint
-- Backfill: a run that sized one ticket is a run that sizes one bounty.
-- After the old indexes are gone: under the old board index a renamed kind
-- would count as a board's run, and could meet that board's backlog run.
UPDATE "bounty_run" SET "kind" = 'bounty' WHERE "kind" = 'ticket';--> statement-breakpoint
-- Backfill: the JSON a run and a profile keep names the bounty the same way
-- the columns do. A plan or outcome without a ticket id is left as it is.
UPDATE "bounty_run" SET "planned" = (
  SELECT jsonb_agg(
    CASE WHEN e ? 'ticketId' THEN (e - 'ticketId') || jsonb_build_object('bountyId', e -> 'ticketId') ELSE e END
    ORDER BY o)
  FROM jsonb_array_elements("bounty_run"."planned") WITH ORDINALITY AS x(e, o)
) WHERE jsonb_path_exists("planned", '$[*].ticketId');--> statement-breakpoint
UPDATE "bounty_run" SET "outcomes" = (
  SELECT jsonb_agg(
    CASE WHEN e ? 'ticketId' THEN (e - 'ticketId') || jsonb_build_object('bountyId', e -> 'ticketId') ELSE e END
    ORDER BY o)
  FROM jsonb_array_elements("bounty_run"."outcomes") WITH ORDINALITY AS x(e, o)
) WHERE jsonb_path_exists("outcomes", '$[*].ticketId');--> statement-breakpoint
UPDATE "bounty_profile" SET "profile" = ("profile" - 'ticket') || jsonb_build_object('bounty', "profile" -> 'ticket')
WHERE "profile" ? 'ticket';--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_sandbox_version_id_sandbox_version_id_fk" FOREIGN KEY ("sandbox_version_id") REFERENCES "public"."sandbox_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_run_id_analysis_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_organization_id_idx" ON "submission" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "bounty_proposal" ADD CONSTRAINT "bounty_proposal_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_bounty_id_bounty_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounty_proposal_bounty_id_idx" ON "bounty_proposal" USING btree ("bounty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_bounty_active_unique" ON "bounty_run" USING btree ("bounty_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" = 'bounty';--> statement-breakpoint
CREATE INDEX "bounty_run_bounty_id_idx" ON "bounty_run" USING btree ("bounty_id");--> statement-breakpoint
CREATE INDEX "bounty_organization_created_idx" ON "bounty" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "bounty_repo_id_idx" ON "bounty" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_proposal_live_unique" ON "bounty_proposal" USING btree ("bounty_id") WHERE "bounty_proposal"."status" in ('proposed', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "bounty_run_board_active_unique" ON "bounty_run" USING btree ("board_id") WHERE "bounty_run"."status" in ('queued', 'running') and "bounty_run"."kind" not in ('issue', 'respec', 'bounty');--> statement-breakpoint
ALTER TABLE "jira_issue" ADD CONSTRAINT "jira_issue_bounty_unique" UNIQUE("bounty_id");--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_bounty_id_unique" UNIQUE("bounty_id");--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_organization_number_unique" UNIQUE("organization_id","number");--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_kind_check" CHECK ("bounty_run"."kind" in ('backlog', 'reprice', 'issue', 'respec', 'bounty'));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_scope_check" CHECK (("bounty_run"."kind" not in ('backlog', 'issue') OR "bounty_run"."board_id" IS NOT NULL) AND ("bounty_run"."kind" <> 'bounty' OR "bounty_run"."bounty_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bounty_run" ADD CONSTRAINT "bounty_run_source_check" CHECK (("bounty_run"."kind" in ('backlog', 'issue', 'bounty') AND "bounty_run"."source_proposal_id" IS NULL AND "bounty_run"."source_revision" IS NULL) OR ("bounty_run"."kind" in ('reprice', 'respec') AND "bounty_run"."source_revision" > 0));--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_number_check" CHECK ("bounty"."number" > 0);--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_title_check" CHECK (char_length("bounty"."title") between 1 and 255);--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_origin_check" CHECK ("bounty"."origin" in ('manual', 'jira'));--> statement-breakpoint
ALTER TABLE "bounty" ADD CONSTRAINT "bounty_revision_check" CHECK ("bounty"."revision" > 0);