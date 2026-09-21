/**
 * Database-level race and rollback checks for the bounty workflow.
 *
 * This is deliberately outside the ordinary test glob: it creates and drops
 * a database and is intended for a disposable local or CI Postgres. Run it
 * with `npm run test:bounty-concurrency -w @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_bounty_test";

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

const selection = { batchSize: 5, scanLimit: 20 };
const rateCard = {
  currency: "USD",
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
};

describe("bounty database concurrency", () => {
  let sql: postgres.Sql;

  before(async () => {
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
      await admin.unsafe(`create database ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }

    await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
    sql = postgres(scratchUrl(), { max: 6 });

    await sql`
      insert into "user" (id, name, email, username, display_username)
      values ('user_bounty', 'Bounty User', 'bounty@example.test', 'bounty-user', 'bounty-user')
    `;
    await sql`
      insert into organization (id, name, slug)
      values ('org_bounty', 'Bounty Org', 'bounty-org')
    `;
    await sql`
      insert into jira_connection (id, organization_id, cloud_id, site_url, site_name)
      values ('conn_bounty', 'org_bounty', 'cloud_bounty', 'https://example.test', 'Example')
    `;
    await sql`
      insert into jira_board (id, organization_id, connection_id, external_id, name, board_type)
      values ('board_bounty', 'org_bounty', 'conn_bounty', '42', 'Backlog', 'scrum')
    `;
    await sql`
      insert into jira_issue (
        id, organization_id, board_id, external_id, key, status_category,
        remote_created_at, remote_updated_at
      ) values
        ('issue_race', 'org_bounty', 'board_bounty', '1001', 'DEMO-1', 'new', now(), now()),
        ('issue_rollback', 'org_bounty', 'board_bounty', '1002', 'DEMO-2', 'new', now(), now())
    `;
  });

  after(async () => {
    await sql?.end();
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
  });

  function insertRun(id: string, requestId: string, status: string) {
    return sql`
      insert into bounty_run (
        id, organization_id, board_id, started_by, request_id, status,
        selection, rate_card, requested_model, prompt_version
      ) values (
        ${id}, 'org_bounty', 'board_bounty', 'user_bounty', ${requestId},
        ${status}, ${sql.json(selection)}, ${sql.json(rateCard)},
        'model-test', 'v1'
      )
    `;
  }

  function insertProposal(id: string, runId: string, issueId: string) {
    return sql`
      insert into bounty_proposal (
        id, organization_id, run_id, jira_issue_id, spec_hash, rate_card,
        model_complexity, model_confidence, model_rationale, actual_model,
        prompt_version, complexity, amount_minor, currency
      ) values (
        ${id}, 'org_bounty', ${runId}, ${issueId}, ${"a".repeat(64)},
        ${sql.json(rateCard)}, 'M', 'high', 'A bounded medium change.',
        'model-test', 'v1', 'M', 200, 'USD'
      )
    `;
  }

  test("only one concurrent run can be active for a board", async () => {
    const attempts = await Promise.allSettled([
      insertRun("run_active_a", "request-active-a", "queued"),
      insertRun("run_active_b", "request-active-b", "queued"),
    ]);

    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === "rejected").length,
      1,
    );
    await sql`update bounty_run set status = 'succeeded' where status = 'queued'`;
  });

  test("only one concurrent live proposal can exist for an issue", async () => {
    await insertRun("run_proposal_a", "request-proposal-a", "succeeded");
    await insertRun("run_proposal_b", "request-proposal-b", "succeeded");

    const attempts = await Promise.allSettled([
      insertProposal("proposal_race_a", "run_proposal_a", "issue_race"),
      insertProposal("proposal_race_b", "run_proposal_b", "issue_race"),
    ]);

    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === "rejected").length,
      1,
    );
  });

  test("a failed replacement restores the source proposal", async () => {
    await insertRun("run_rollback", "request-rollback", "succeeded");
    await insertProposal("proposal_rollback", "run_rollback", "issue_rollback");

    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`
          update bounty_proposal
          set status = 'superseded'
          where id = 'proposal_rollback'
        `;
        await tx`
          insert into bounty_proposal (
            id, organization_id, run_id, jira_issue_id, spec_hash, rate_card,
            model_complexity, model_confidence, model_rationale, actual_model,
            prompt_version, complexity, amount_minor, currency,
            replaces_proposal_id
          ) values (
            'proposal_invalid', 'org_bounty', 'run_rollback', 'issue_rollback',
            ${"b".repeat(64)}, ${tx.json(rateCard)}, 'M', 'high',
            'A replacement that must roll back.', 'model-test', 'v1',
            'M', null, 'USD', 'proposal_rollback'
          )
        `;
      }),
    );

    const rows = await sql`
      select status from bounty_proposal where id = 'proposal_rollback'
    `;
    assert.equal(rows[0]?.["status"], "proposed");
  });
});
