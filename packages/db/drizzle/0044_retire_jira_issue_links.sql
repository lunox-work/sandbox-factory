ALTER TABLE "sandbox_jira_issue" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sandbox_jira_issue" CASCADE;--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP CONSTRAINT "bounty_proposal_jira_issue_id_jira_issue_id_fk";
--> statement-breakpoint
ALTER TABLE "bounty_proposal" DROP COLUMN "jira_issue_id";