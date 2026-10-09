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
import { stepUp, trimSpec, type SpecDraft } from "sandbox-factory";

import {
  createBountyProfileStore,
  createBountyProposalStore,
  createBountyRunStore,
  createBountySpecStore,
  createBountyWritebackStore,
  createConnection,
  createBountyStore,
  createSandboxStore,
  type NewBountySpec,
} from "../src/index.js";
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
  xsMinor: 100,
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
    await importIssues([
      ["issue_race", "board_bounty", "1001", "DEMO-1"],
      ["issue_rollback", "board_bounty", "1002", "DEMO-2"],
      ["issue_lease", "board_bounty", "1003", "DEMO-3"],
      ["issue_states", "board_bounty", "1004", "DEMO-4"],
      ["issue_repriced", "board_bounty", "1005", "DEMO-5"],
      ["issue_version", "board_bounty", "1090", "DEMO-90"],
    ]);
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

  /**
   * Jira issues as a run imports them: each pointer with its bounty. The
   * bounty takes the pointer's id, so a test names one thing either way.
   */
  async function importIssues(
    rows: readonly (readonly [
      id: string,
      boardId: string,
      externalId: string,
      key: string,
    ])[],
  ) {
    for (const [id, boardId, externalId, key] of rows) {
      await sql`
        insert into bounty (id, organization_id, title, origin)
        values (${id}, 'org_bounty', ${key}, 'jira')
      `;
      await sql`
        insert into jira_issue (
          id, organization_id, board_id, external_id, key, bounty_id
        ) values (
          ${id}, 'org_bounty', ${boardId}, ${externalId}, ${key}, ${id}
        )
      `;
    }
  }

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

  function insertProposal(
    id: string,
    runId: string,
    issueId: string,
    on: postgres.Sql | postgres.TransactionSql = sql,
  ) {
    return on`
      insert into bounty_proposal (
        id, organization_id, run_id, bounty_id, spec_hash, rate_card,
        model_complexity, model_confidence, model_rationale, actual_model,
        prompt_version, complexity, amount_minor, currency
      ) values (
        ${id}, 'org_bounty', ${runId}, ${issueId}, ${"a".repeat(64)},
        ${on.json(rateCard)}, 'M', 'high', 'A bounded medium change.',
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

  test("a one-bounty run is created beside the board's active run", async () => {
    // Through the store, so the insert is the one the add route makes: the
    // kind, the plan, no source proposal. The fake database cannot see the
    // table's checks, which is how an issue run once failed every insert.
    await insertRun("run_backlog_active", "request-backlog-active", "running");
    const connection = createConnection({ url: scratchUrl() });
    const runs = createBountyRunStore(connection.db);
    const planned = [
      { externalIssueId: "1001", issueKey: "DEMO-1", summary: "Race" },
    ];
    // Closed after, or dropping the scratch database waits on it forever.
    const created = await runs
      .create("org_bounty", {
        kind: "issue",
        planned,
        boardId: "board_bounty",
        startedBy: "user_bounty",
        requestId: "7b1f5a36-6c51-4d7e-9a57-3d0f2c1e8b41",
        selection: {
          unassignedOnly: false,
          issueTypes: [],
          minAgeDays: 0,
          minSpecChars: 0,
          categories: {},
        },
        rateCard,
        requestedModel: "model-test",
        promptVersion: "v1",
      })
      .finally(() => connection.close());
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.run.kind, "issue");
      assert.deepEqual(created.run.planned, planned);
    }
    await sql`update bounty_run set status = 'succeeded' where status in ('queued', 'running')`;
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

  test("lease-fenced updates bind their timestamps for the driver", async () => {
    // Every lease-fenced update compares `lease_expires_at` and
    // `deadline_at` with a `Date`. Through Drizzle's postgres-js driver a
    // Date interpolated into a raw `sql` template reaches the wire unmapped
    // and the driver throws, while `gt(column, date)` maps it through the
    // column. The unit tests run on a fake that never serializes, so this is
    // the only place the difference shows.
    const connection = createConnection({ url: scratchUrl(), max: 2 });
    try {
      const runs = createBountyRunStore(connection.db);
      const proposals = createBountyProposalStore(connection.db);
      const writebacks = createBountyWritebackStore(connection.db);
      await insertRun("run_lease", "request-lease", "queued");

      const now = new Date();
      const claimed = await runs.claim(
        "org_bounty",
        "run_lease",
        "lease_1",
        now,
      );
      assert.equal(claimed?.status, "running");
      assert.equal(
        await runs.heartbeat(
          "org_bounty",
          "run_lease",
          "lease_1",
          new Date(now.getTime() + 1_000),
        ),
        true,
      );
      // An outcome needs a plan to belong to: before one is recorded there
      // is no bounty it could be the outcome of.
      const outcome = (externalIssueId: string) =>
        runs.recordOutcome("org_bounty", "run_lease", "lease_1", {
          externalIssueId,
          issueKey: `DEMO-${externalIssueId}`,
          status: "proposed",
        });
      assert.equal(await outcome("1003"), false);

      // The plan is stored with its reasons, and moves the deadline out by
      // its size. 60 bounties, because the bound on outcomes used to be a
      // fixed 50 and a run now takes every bounty that matches.
      const plan = Array.from({ length: 60 }, (_, index) => ({
        externalIssueId: String(2000 + index),
        issueKey: `DEMO-${2000 + index}`,
        summary: `Bounty ${index}`,
        categories: [
          {
            id: "left-behind",
            label: "Left behind",
            reason: "Open 412 days, never in a sprint, unassigned",
          },
        ],
      }));
      const planned = await runs.recordPlan(
        "org_bounty",
        "run_lease",
        "lease_1",
        plan,
      );
      assert.deepEqual(planned?.planned, plan);
      assert.ok(
        Date.parse(planned?.deadlineAt ?? "") >
          Date.parse(claimed?.deadlineAt ?? "") + 60 * 19_000,
      );

      for (const bounty of plan) {
        assert.equal(await outcome(bounty.externalIssueId), true);
      }
      // One outcome per planned bounty, and no more.
      assert.equal(await outcome("9999"), false);

      const created = await proposals.createForLease("org_bounty", "lease_1", {
        runId: "run_lease",
        bountyId: "issue_lease",
        specHash: "c".repeat(64),
        specHashVersion: 1,
        rateCard,
        sizing: {
          complexity: "M",
          confidence: "high",
          rationale: "A bounded medium change.",
        },
        inputTruncated: false,
        actualModel: "model-test",
        promptVersion: "v1",
        amountMinor: 200,
        currency: "USD",
      });
      assert.equal(created.status, "created");
      if (created.status !== "created") return;

      const approved = await writebacks.approveWithIntent(
        "org_bounty",
        created.proposal.id,
        created.proposal.revision,
        "user_bounty",
        {
          complexity: "M",
          amountMinor: 200,
          currency: "USD",
          proposalUrl: "https://example.test/proposals/1",
        },
      );
      assert.equal(approved.status, "created");
      if (approved.status !== "created") return;
      const writebackNow = new Date();
      const operation = await writebacks.claim(
        "org_bounty",
        approved.operation.id,
        "lease_2",
        writebackNow,
      );
      assert.equal(operation?.status, "running");
      assert.equal(
        await writebacks.heartbeat(
          "org_bounty",
          approved.operation.id,
          "lease_2",
          new Date(writebackNow.getTime() + 1_000),
        ),
        true,
      );

      const finished = await runs.finish(
        "org_bounty",
        "run_lease",
        "lease_1",
        "succeeded",
        { candidatesScanned: 1 },
      );
      assert.equal(finished?.status, "succeeded");
      assert.equal(finished?.outcomes.length, plan.length);
    } finally {
      await connection.close();
    }
  });

  test("a failed follow-up write restores the proposal it decided", async () => {
    // The shape of every decision here: the proposal's status changes and a
    // second write follows in the same transaction. If the second write is
    // refused, the first must not survive it.
    await insertRun("run_rollback", "request-rollback", "succeeded");
    await insertProposal("proposal_rollback", "run_rollback", "issue_rollback");

    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`
          update bounty_proposal
          set status = 'approved', version = 1, versioned_at = now(),
            version_revision = 2
          where id = 'proposal_rollback'
        `;
        // A write-back of a kind the schema no longer knows.
        await tx`
          insert into bounty_writeback (
            id, organization_id, proposal_id, proposal_revision, kind, payload
          ) values (
            'bwo_invalid', 'org_bounty', 'proposal_rollback', 2, 'superseded',
            ${tx.json({ complexity: "M", amountMinor: 200, currency: "USD", proposalUrl: "https://example.test/p" })}
          )
        `;
      }),
    );

    const rows = await sql`
      select status from bounty_proposal where id = 'proposal_rollback'
    `;
    assert.equal(rows[0]?.["status"], "proposed");
  });

  test("a re-priced proposal can still be removed", async () => {
    // A reprice run points at the proposal it re-priced, and the pointer is
    // `ON DELETE SET NULL`. The run's check must accept the cleared pointer,
    // or Postgres refuses the delete (and the bounty's cascade with it).
    await insertRun("run_repriced", "request-repriced", "succeeded");
    await insertProposal("proposal_repriced", "run_repriced", "issue_repriced");
    await sql`
      insert into bounty_run (
        id, organization_id, board_id, started_by, request_id, status, kind,
        source_proposal_id, source_revision,
        selection, rate_card, requested_model, prompt_version
      ) values (
        'run_reprice_of', 'org_bounty', 'board_bounty', 'user_bounty',
        'request-reprice-of', 'succeeded', 'reprice',
        'proposal_repriced', 1,
        ${sql.json(selection)}, ${sql.json(rateCard)}, 'model-test', 'v1'
      )
    `;

    const connection = createConnection({ url: scratchUrl() });
    const removed = await createBountyProposalStore(connection.db)
      .remove("org_bounty", "proposal_repriced", 1)
      .finally(() => connection.close());
    assert.equal(removed.ok, true);

    const runs = await sql`
      select source_proposal_id, source_revision
      from bounty_run where id = 'run_reprice_of'
    `;
    assert.equal(runs[0]?.["source_proposal_id"], null);
    assert.equal(runs[0]?.["source_revision"], 1);
  });

  test("a proposal may only be proposed or approved", async () => {
    await insertRun("run_states", "request-states", "succeeded");
    await insertProposal("proposal_states", "run_states", "issue_states");
    await assert.rejects(
      sql`update bounty_proposal set status = 'rejected' where id = 'proposal_states'`,
    );
    await assert.rejects(
      sql`update bounty_proposal set status = 'superseded' where id = 'proposal_states'`,
    );
    // Approved only as a version.
    await assert.rejects(
      sql`update bounty_proposal set status = 'approved' where id = 'proposal_states'`,
    );
    await sql`
      update bounty_proposal
      set status = 'approved', version = 1, versioned_at = now(),
        version_revision = 1
      where id = 'proposal_states'
    `;
    await sql`delete from bounty_proposal where id = 'proposal_states'`;
  });

  test("a proposal's version moves on an approval of something changed, not on a withdrawal", async () => {
    await insertRun("run_version", "request-version", "succeeded");
    await insertProposal("proposal_version", "run_version", "issue_version");
    const connection = createConnection({ url: scratchUrl() });
    const proposals = createBountyProposalStore(connection.db);
    const writebacks = createBountyWritebackStore(connection.db);
    try {
      const approved = await proposals.approve(
        "org_bounty",
        "proposal_version",
        1,
        "user_bounty",
        "off",
      );
      assert.ok(approved.ok);
      assert.equal(approved.proposal.version, 1);
      const first = approved.proposal.versionedAt;
      assert.notEqual(first, null);

      // Withdrawn and approved again as it was: the same version, from
      // the same moment, whichever way the approval goes.
      const withdrawn = await proposals.withdraw(
        "org_bounty",
        "proposal_version",
        2,
      );
      assert.ok(withdrawn.ok);
      assert.equal(withdrawn.proposal.version, 1);
      const again = await writebacks.approveWithIntent(
        "org_bounty",
        "proposal_version",
        3,
        "user_bounty",
        {
          complexity: "M",
          amountMinor: 200,
          currency: "USD",
          proposalUrl: "https://example.test/p",
        },
      );
      assert.equal(again.status, "created");
      let rows = await sql`
        select revision, version, versioned_at from bounty_proposal
        where id = 'proposal_version'
      `;
      assert.equal(rows[0]?.["revision"], 4);
      assert.equal(rows[0]?.["version"], 1);
      assert.equal((rows[0]?.["versioned_at"] as Date).toISOString(), first);

      // Withdrawn, changed, and approved: the next version, from now.
      const back = await writebacks.withdrawWithIntent(
        "org_bounty",
        "proposal_version",
        4,
        "user_bounty",
        {
          complexity: "M",
          amountMinor: 200,
          currency: "USD",
          proposalUrl: "https://example.test/p",
        },
      );
      assert.equal(back.status, "created");
      const resized = await proposals.resize(
        "org_bounty",
        "proposal_version",
        5,
        "user_bounty",
        "L",
        300,
        "USD",
      );
      assert.ok(resized.ok);
      assert.equal(resized.proposal.version, 1);
      const changed = await proposals.approve(
        "org_bounty",
        "proposal_version",
        6,
        "user_bounty",
        "off",
      );
      assert.ok(changed.ok);
      assert.equal(changed.proposal.version, 2);
      assert.ok(
        Date.parse(changed.proposal.versionedAt ?? "") >
          Date.parse(first ?? ""),
      );
      rows = await sql`
        select version_revision from bounty_proposal
        where id = 'proposal_version'
      `;
      assert.equal(rows[0]?.["version_revision"], 7);
    } finally {
      await connection.close();
    }
  });
  test("proposals are counted and filtered by the category their bounty was picked for", async () => {
    // The category lives in the run's plan, as jsonb, and both reads reach
    // into it in SQL. The fake database returns whatever it is handed, so
    // only a real Postgres can say whether the filter and the per-proposal
    // read select what they claim to.
    await sql`
      insert into jira_board (id, organization_id, connection_id, external_id, name, board_type)
      values ('board_categories', 'org_bounty', 'conn_bounty', '43', 'Categories', 'scrum')
    `;
    await importIssues([
      ["issue_cat_1", "board_categories", "3001", "CAT-1"],
      ["issue_cat_2", "board_categories", "3002", "CAT-2"],
      ["issue_cat_3", "board_categories", "3003", "CAT-3"],
      ["issue_cat_4", "board_categories", "3004", "CAT-4"],
    ]);
    const match = (id: string, label: string) => ({ id, label, reason: "r" });
    const leftBehind = match("left-behind", "Left behind");
    const paperCuts = match("paper-cuts", "Paper cuts");
    const planned = [
      {
        externalIssueId: "3001",
        issueKey: "CAT-1",
        summary: "One",
        categories: [leftBehind, paperCuts],
      },
      {
        externalIssueId: "3002",
        issueKey: "CAT-2",
        summary: "Two",
        categories: [paperCuts],
      },
      // Picked by hand: an empty list. And a plan entry from before
      // categories existed: no list at all.
      {
        externalIssueId: "3003",
        issueKey: "CAT-3",
        summary: "Three",
        categories: [],
      },
      { externalIssueId: "3004", issueKey: "CAT-4", summary: "Four" },
      // In the plan, in a category, and never proposed: not counted.
      {
        externalIssueId: "3999",
        issueKey: "CAT-999",
        summary: "None",
        categories: [leftBehind],
      },
    ];
    await sql`
      insert into bounty_run (
        id, organization_id, board_id, started_by, request_id, status,
        selection, rate_card, requested_model, prompt_version, planned
      ) values (
        'run_categories', 'org_bounty', 'board_categories', 'user_bounty',
        'request-categories', 'succeeded', ${sql.json(selection)},
        ${sql.json(rateCard)}, 'model-test', 'v1', ${sql.json(planned)}
      )
    `;
    for (const n of [1, 2, 3, 4]) {
      await insertProposal(
        `proposal_cat_${n}`,
        "run_categories",
        `issue_cat_${n}`,
      );
    }

    const connection = createConnection({ url: scratchUrl(), max: 2 });
    try {
      const proposals = createBountyProposalStore(connection.db);

      assert.deepEqual(
        await proposals.categoryCounts("org_bounty", {
          boardId: "board_categories",
        }),
        {
          total: 4,
          uncategorized: 2,
          counts: { "left-behind": 1, "paper-cuts": 2 },
        },
      );

      const keys = async (category?: string) =>
        (
          await proposals.list("org_bounty", {
            boardId: "board_categories",
            ...(category === undefined ? {} : { category }),
          })
        )
          .map(({ issueKey }) => issueKey)
          .sort();
      assert.deepEqual(await keys(), ["CAT-1", "CAT-2", "CAT-3", "CAT-4"]);
      assert.deepEqual(await keys("paper-cuts"), ["CAT-1", "CAT-2"]);
      assert.deepEqual(await keys("left-behind"), ["CAT-1"]);
      assert.deepEqual(await keys("deadline-exposed"), []);
      // The id is data inside a JSON parameter, not SQL.
      assert.deepEqual(await keys(`x"}] or true --`), []);

      // In no category: the empty list and the missing one, which is the
      // two the count above calls uncategorized.
      assert.deepEqual(
        (
          await proposals.list("org_bounty", {
            boardId: "board_categories",
            uncategorized: true,
          })
        )
          .map(({ issueKey }) => issueKey)
          .sort(),
        ["CAT-3", "CAT-4"],
      );

      // A filtered row still carries its own reasons.
      const [first] = await proposals.list("org_bounty", {
        boardId: "board_categories",
        category: "left-behind",
      });
      assert.deepEqual(
        first?.categories.map(({ id }) => id),
        ["left-behind", "paper-cuts"],
      );

      // Paged one at a time across rows made in one millisecond, none is
      // skipped: a cursor holds milliseconds, and Postgres microseconds.
      await sql`
        update bounty_proposal
        set created_at = timestamptz '2026-10-03 00:00:00.123Z'
          + right(id, 1)::int * 100 * interval '1 microsecond'
        where id like 'proposal_cat_%'
      `;
      const paged: (string | null)[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (;;) {
        const [row] = await proposals.list("org_bounty", {
          boardId: "board_categories",
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (row === undefined) break;
        paged.push(row.issueKey);
        cursor = { createdAt: row.createdAt, id: row.id };
      }
      assert.deepEqual(paged, ["CAT-4", "CAT-3", "CAT-2", "CAT-1"]);

      // Another organization sees none of it.
      assert.deepEqual(
        await proposals.categoryCounts("org_other", {
          boardId: "board_categories",
        }),
        { total: 0, uncategorized: 0, counts: {} },
      );
    } finally {
      await connection.close();
    }
  });

  test("a spec is written with its proposal, revised by a re-price, and goes with it", async () => {
    // The proposal and its spec are two tables written in one transaction,
    // under a lease checked in SQL, with a jsonb column and three checks.
    // The fake database sees none of that.
    await sql`
      insert into jira_board (id, organization_id, connection_id, external_id, name, board_type)
      values ('board_spec', 'org_bounty', 'conn_bounty', '44', 'Specs', 'scrum')
    `;
    await importIssues([
      ["issue_spec", "board_spec", "4001", "SPEC-1"],
      ["issue_spec_lost", "board_spec", "4002", "SPEC-2"],
    ]);
    await sql`insert into github_connection (id, organization_id, installation_id, account_login, account_type, repository_selection, permissions) values ('ghc_profile', 'org_bounty', '991', 'example', 'Organization', 'all', '{}')`;
    await sql`insert into github_repo (id, organization_id, connection_id, role, external_id, full_name, default_branch) values ('ghr_profile', 'org_bounty', 'ghc_profile', 'source', '992', 'example/source', 'main')`;
    await sql`insert into repo_snapshot (id, repo_id, commit_sha, ref, tree_sha, tree_key, file_count, total_bytes, languages, facts) values ('rsn_profile', 'ghr_profile', 'abc', 'refs/heads/main', 'tree', 'tree-key', 1, 1, '{}', '{}')`;
    // A second repository the work touches, named before the first.
    await sql`insert into github_repo (id, organization_id, connection_id, role, external_id, full_name, default_branch) values ('ghr_profile_api', 'org_bounty', 'ghc_profile', 'source', '993', 'example/api', 'main')`;
    await sql`insert into repo_snapshot (id, repo_id, commit_sha, ref, tree_sha, tree_key, file_count, total_bytes, languages, facts) values ('rsn_profile_api', 'ghr_profile_api', 'def', 'refs/heads/main', 'tree', 'tree-key-api', 1, 1, '{}', '{}')`;
    const queueRun = (
      id: string,
      source: { proposalId: string; revision: number } | null,
    ) => sql`
      insert into bounty_run (
        id, organization_id, board_id, started_by, request_id, status, kind,
        source_proposal_id, source_revision,
        selection, rate_card, requested_model, prompt_version
      ) values (
        ${id}, 'org_bounty', 'board_spec', 'user_bounty', ${`request-${id}`},
        'queued', ${source === null ? "backlog" : "reprice"},
        ${source?.proposalId ?? null}, ${source?.revision ?? null},
        ${sql.json(selection)}, ${sql.json(rateCard)}, 'model-test', 'v1'
      )
    `;
    const spec = (title: string): NewBountySpec => ({
      specHash: "d".repeat(64),
      specHashVersion: 1,
      draft: {
        feature: "CSV export",
        background: ["a signed-in analyst"],
        scenarios: [
          {
            id: "s1",
            kind: "happy",
            title,
            steps: [
              { keyword: "When", text: "they press Export" },
              { keyword: "Then", text: "a CSV file is downloaded" },
            ],
            origin: "draft",
          },
        ],
        openQuestions: ["Is there a row limit?"],
        assumptions: [],
      },
      origin: "draft",
      actualModel: "model-test",
      promptVersion: "draft-v1",
    });
    const input = (runId: string, bountyId: string) => ({
      runId,
      repositories: [
        { repoId: "ghr_profile", snapshotId: "rsn_profile" },
        { repoId: "ghr_profile_api", snapshotId: "rsn_profile_api" },
      ],
      profileIntent: true,
      bountyId,
      specHash: "d".repeat(64),
      specHashVersion: 1,
      rateCard,
      sizing: {
        complexity: "M" as const,
        confidence: "high" as const,
        rationale: "A bounded medium change.",
      },
      inputTruncated: false,
      actualModel: "model-test",
      promptVersion: "v1",
      amountMinor: 200,
      currency: "USD",
    });
    const specRows = async () =>
      Number(
        (await sql`select count(*)::int as count from bounty_spec`)[0]?.[
          "count"
        ],
      );

    const connection = createConnection({ url: scratchUrl(), max: 2 });
    try {
      const runs = createBountyRunStore(connection.db);
      const proposals = createBountyProposalStore(connection.db);
      const specs = createBountySpecStore(connection.db);

      // Revision 1, with the proposal.
      await queueRun("run_spec_a", null);
      await runs.claim("org_bounty", "run_spec_a", "lease_a", new Date());
      const first = spec("The filtered table is exported");
      // Intent is required when enabled: a failed insert rolls back the
      // proposal and spec too, including the lease-fenced write.
      await sql.unsafe(
        "create function reject_profile_intent() returns trigger language plpgsql as $$ begin raise exception 'intent rejected'; end $$",
      );
      await sql.unsafe(
        "create trigger reject_profile before insert on bounty_profile for each row execute function reject_profile_intent()",
      );
      try {
        await assert.rejects(
          proposals.createForLease("org_bounty", "lease_a", {
            ...input("run_spec_a", "issue_spec"),
            spec: first,
          }),
        );
        assert.equal(
          Number(
            (
              await sql`select count(*)::int as n from bounty_proposal where run_id = 'run_spec_a'`
            )[0]?.["n"],
          ),
          0,
        );
        assert.equal(
          Number(
            (
              await sql`select count(*)::int as n from bounty_spec where run_id = 'run_spec_a'`
            )[0]?.["n"],
          ),
          0,
        );
        assert.equal(
          Number(
            (await sql`select count(*)::int as n from bounty_profile`)[0]?.[
              "n"
            ],
          ),
          0,
        );
      } finally {
        await sql.unsafe("drop trigger reject_profile on bounty_profile");
        await sql.unsafe("drop function reject_profile_intent()");
      }
      const created = await proposals.createForLease("org_bounty", "lease_a", {
        ...input("run_spec_a", "issue_spec"),
        spec: first,
      });
      assert.equal(created.status, "created");
      if (created.status !== "created") return;
      const proposalId = created.proposal.id;
      assert.equal(created.proposal.specRevision, 1);
      assert.deepEqual(created.proposal.repositories, [
        { repoId: "ghr_profile", snapshotId: "rsn_profile" },
        { repoId: "ghr_profile_api", snapshotId: "rsn_profile_api" },
      ]);

      // A new process can discover work without the post-commit wake-up.
      const profiles = createBountyProfileStore(connection.db);
      assert.ok(
        (await profiles.organizationsWithPending()).includes("org_bounty"),
      );
      // One profile for each repository the work touches.
      const pending = (await profiles.pending("org_bounty")).filter(
        (row) => row.proposalId === proposalId,
      );
      assert.deepEqual(
        pending
          .map(({ specRevision, specHash, snapshotId, repository }) => ({
            specRevision,
            specHash,
            snapshotId,
            repository,
          }))
          .sort((a, b) =>
            String(a.snapshotId).localeCompare(String(b.snapshotId)),
          ),
        [
          {
            specRevision: 1,
            specHash: first.specHash,
            snapshotId: "rsn_profile",
            repository: "example/source",
          },
          {
            specRevision: 1,
            specHash: first.specHash,
            snapshotId: "rsn_profile_api",
            repository: "example/api",
          },
        ],
      );
      // Asked again for each snapshot, the revision keeps the rows the
      // sizing made, and each ask reads back its own.
      for (const snapshotId of ["rsn_profile", "rsn_profile_api"]) {
        const asked = await profiles.request("org_bounty", {
          proposalId,
          specRevision: 1,
          specHash: first.specHash,
          snapshotId,
        });
        assert.equal(asked?.snapshotId, snapshotId);
        assert.equal(
          asked?.id,
          pending.find((row) => row.snapshotId === snapshotId)?.id,
        );
      }
      assert.equal(
        (await profiles.pending("org_bounty")).filter(
          (row) => row.proposalId === proposalId,
        ).length,
        2,
      );
      // The newest revision's, in name order.
      assert.deepEqual(
        (await profiles.latest("org_bounty", proposalId)).map(
          ({ repository }) => repository,
        ),
        ["example/api", "example/source"],
      );
      assert.deepEqual(await profiles.latest("org_other", proposalId), []);
      const stored = await specs.get("org_bounty", proposalId, 1);
      assert.match(stored?.id ?? "", /^bsp_/);
      assert.deepEqual(stored?.draft, first.draft);
      assert.equal(stored?.runId, "run_spec_a");
      assert.equal(stored?.createdBy, null);
      assert.equal(stored?.promptVersion, "draft-v1");

      // A worker that lost its lease writes neither the proposal nor a spec.
      const before = await specRows();
      const lost = await proposals.createForLease("org_bounty", "stale", {
        ...input("run_spec_a", "issue_spec_lost"),
        spec: first,
      });
      assert.equal(lost.status, "lost-lease");
      assert.equal(await specRows(), before);

      // A second proposal for the same bounty is refused, and so is its spec.
      const duplicate = await proposals.createForLease(
        "org_bounty",
        "lease_a",
        { ...input("run_spec_a", "issue_spec"), spec: first },
      );
      assert.equal(duplicate.status, "duplicate");
      assert.equal(await specRows(), before);
      await runs.finish("org_bounty", "run_spec_a", "lease_a", "succeeded");

      // A re-price that drafts again: revision 2, and the proposal follows.
      await queueRun("run_spec_b", { proposalId, revision: 1 });
      await runs.claim("org_bounty", "run_spec_b", "lease_b", new Date());
      const second = spec("The visible rows are exported");
      const repriced = await proposals.repriceForLease(
        "org_bounty",
        "lease_b",
        proposalId,
        1,
        { ...input("run_spec_b", "issue_spec"), spec: second },
      );
      assert.equal(repriced.status, "repriced");
      if (repriced.status !== "repriced") return;
      assert.equal(repriced.proposal.specRevision, 2);
      assert.deepEqual(
        (await specs.get("org_bounty", proposalId, 2))?.draft,
        second.draft,
      );
      assert.deepEqual(
        (await profiles.latest("org_bounty", proposalId)).map(
          ({ specRevision, repository }) => [specRevision, repository],
        ),
        [
          [2, "example/api"],
          [2, "example/source"],
        ],
      );
      // The revision it replaced keeps its own.
      assert.deepEqual(
        (await profiles.forRevision("org_bounty", proposalId, 1)).map(
          ({ id }) => id,
        ),
        pending
          .slice()
          .sort((a, b) =>
            String(a.repository).localeCompare(String(b.repository)),
          )
          .map(({ id }) => id),
      );
      assert.equal(
        (await profiles.pending("org_bounty")).filter(
          (row) => row.proposalId === proposalId,
        ).length,
        4,
      );
      // The revision it replaced is still there to read.
      assert.deepEqual(
        (await specs.get("org_bounty", proposalId, 1))?.draft,
        first.draft,
      );
      assert.deepEqual(
        (await specs.listRevisions("org_bounty", proposalId)).map(
          ({ revision, scenarioCount, openQuestionCount }) => ({
            revision,
            scenarioCount,
            openQuestionCount,
          }),
        ),
        [
          { revision: 2, scenarioCount: 1, openQuestionCount: 1 },
          { revision: 1, scenarioCount: 1, openQuestionCount: 1 },
        ],
      );
      await runs.finish("org_bounty", "run_spec_b", "lease_b", "succeeded");

      // A re-price that drafts nothing: no pointer, the history kept.
      await queueRun("run_spec_c", { proposalId, revision: 2 });
      await runs.claim("org_bounty", "run_spec_c", "lease_c", new Date());
      const cleared = await proposals.repriceForLease(
        "org_bounty",
        "lease_c",
        proposalId,
        2,
        input("run_spec_c", "issue_spec"),
      );
      assert.equal(cleared.status, "repriced");
      if (cleared.status !== "repriced") return;
      assert.equal(cleared.proposal.specRevision, null);
      assert.equal(
        (await specs.listRevisions("org_bounty", proposalId)).length,
        2,
      );
      await runs.finish("org_bounty", "run_spec_c", "lease_c", "succeeded");

      // Another organization reads none of it.
      assert.equal(await specs.get("org_other", proposalId, 1), null);
      assert.deepEqual(await specs.listRevisions("org_other", proposalId), []);

      // What the table itself refuses: a second row for a revision, and an
      // origin it does not know.
      const insertSpec = (id: string, revision: number, origin: string) => sql`
        insert into bounty_spec (
          id, organization_id, proposal_id, revision, spec_hash,
          spec_hash_version, draft, origin
        ) values (
          ${id}, 'org_bounty', ${proposalId}, ${revision}, ${"d".repeat(64)},
          1, ${JSON.stringify(first.draft)}::jsonb, ${origin}
        )
      `;
      await assert.rejects(insertSpec("bsp_again", 2, "draft"));
      await assert.rejects(insertSpec("bsp_origin", 3, "rewrite"));
      await assert.rejects(insertSpec("bsp_zero", 0, "draft"));

      // Removing the proposal takes every revision of its spec with it.
      const removed = await proposals.remove("org_bounty", proposalId, 3);
      assert.equal(removed.ok, true);
      assert.equal(
        (await sql`select 1 from bounty_spec where proposal_id = ${proposalId}`)
          .length,
        0,
      );
    } finally {
      await connection.close();
    }
  });

  test("a spec change writes the next revision under its lease, one change at a time per proposal", async () => {
    // The run and proposal locks, the source and spec-revision fences, the
    // new run kind's checks and its partial unique index all live in SQL.
    await sql`
      insert into jira_board (id, organization_id, connection_id, external_id, name, board_type)
      values ('board_respec', 'org_bounty', 'conn_bounty', '45', 'Respec', 'scrum')
    `;
    await importIssues([["issue_respec", "board_respec", "5001", "RESPEC-1"]]);
    const draft: SpecDraft = {
      feature: "CSV export",
      background: [],
      scenarios: [
        {
          id: "s1",
          kind: "happy",
          title: "The filtered table is exported",
          steps: [{ keyword: "Then", text: "a CSV file is downloaded" }],
          origin: "draft",
          weight: "moderate",
        },
        {
          id: "s2",
          kind: "recovery",
          title: "A failed export is retried",
          steps: [{ keyword: "Then", text: "the export runs again" }],
          origin: "draft",
          weight: "heavy",
        },
      ],
      openQuestions: ["Is there a row limit?"],
      assumptions: [],
    };
    const sizedStep = stepUp("M", draft, draft);
    assert.ok(sizedStep !== null);
    const trimmed = trimSpec(draft, ["s2"]);
    const trimStep = stepUp("M", draft, trimmed);
    assert.ok(trimStep !== null);
    const respec = { mode: "trim", removeScenarioIds: ["s2"] } as const;
    const runInput = (requestId: string, sourceRevision: number) => ({
      boardId: "board_respec",
      startedBy: "user_bounty",
      kind: "respec" as const,
      sourceProposalId: "",
      sourceRevision,
      respec,
      requestId,
      selection: {
        unassignedOnly: false,
        issueTypes: [],
        minAgeDays: 0,
        minSpecChars: 0,
        categories: {},
      },
      rateCard,
      requestedModel: "model-test",
      promptVersion: "revise-v1",
    });
    const change = (runId: string, fromSpecRevision: number) => ({
      runId,
      fromSpecRevision,
      spec: {
        specHash: "e".repeat(64),
        specHashVersion: 1,
        draft: trimmed,
        origin: "trim" as const,
        instruction: "Removed A failed export is retried",
        actualModel: null,
        promptVersion: null,
      },
      step: trimStep,
      rubric: null,
      amountMinor: 200,
      currency: "USD",
    });

    const connection = createConnection({ url: scratchUrl(), max: 2 });
    try {
      const runs = createBountyRunStore(connection.db);
      const proposals = createBountyProposalStore(connection.db);
      const specs = createBountySpecStore(connection.db);

      // Sized by a backlog run: revision 1 of the spec, with its step.
      await sql`
        insert into bounty_run (
          id, organization_id, board_id, started_by, request_id, status,
          selection, rate_card, requested_model, prompt_version
        ) values (
          'run_respec_sized', 'org_bounty', 'board_respec', 'user_bounty',
          'request-respec-sized', 'queued', ${sql.json(selection)},
          ${sql.json(rateCard)}, 'model-test', 'v1'
        )
      `;
      await runs.claim("org_bounty", "run_respec_sized", "lease_s", new Date());
      const sized = await proposals.createForLease("org_bounty", "lease_s", {
        runId: "run_respec_sized",
        bountyId: "issue_respec",
        specHash: "e".repeat(64),
        specHashVersion: 1,
        rateCard,
        sizing: { complexity: "M", confidence: "high", rationale: "Medium." },
        inputTruncated: false,
        actualModel: "model-test",
        promptVersion: "v1",
        amountMinor: 200,
        currency: "USD",
        step: sizedStep,
        spec: {
          specHash: "e".repeat(64),
          specHashVersion: 1,
          draft,
          origin: "draft",
          actualModel: "model-test",
          promptVersion: "draft-v2",
        },
      });
      assert.equal(sized.status, "created");
      if (sized.status !== "created") return;
      const proposalId = sized.proposal.id;
      await runs.finish(
        "org_bounty",
        "run_respec_sized",
        "lease_s",
        "succeeded",
      );

      // A change starts while nothing else changes the proposal...
      const first = await runs.create("org_bounty", {
        ...runInput("request-respec-1", 1),
        sourceProposalId: proposalId,
      });
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.deepEqual(first.run.respec, respec);
      // ...and a second waits for it, whoever asks.
      const second = await runs.create("org_bounty", {
        ...runInput("request-respec-2", 1),
        sourceProposalId: proposalId,
        respec: { mode: "expand", kinds: ["boundary"] },
      });
      assert.deepEqual(second, {
        ok: false,
        reason: "active",
        runId: first.run.id,
      });
      // So does a re-price of the same proposal.
      await assert.rejects(sql`
        insert into bounty_run (
          id, organization_id, board_id, started_by, request_id, status, kind,
          source_proposal_id, source_revision,
          selection, rate_card, requested_model, prompt_version
        ) values (
          'run_respec_reprice', 'org_bounty', 'board_respec', 'user_bounty',
          'request-respec-reprice', 'queued', 'reprice', ${proposalId}, 1,
          ${sql.json(selection)}, ${sql.json(rateCard)}, 'model-test', 'v1'
        )
      `);
      // The board's own run does not wait for a change to one proposal.
      const backlog = await runs.create("org_bounty", {
        ...runInput("request-respec-backlog", 1),
        kind: "backlog",
        sourceProposalId: undefined as never,
        sourceRevision: undefined as never,
        respec: undefined as never,
      });
      assert.equal(backlog.ok, true);
      await sql`update bounty_run set status = 'failed' where request_id = 'request-respec-backlog'`;

      // A respec run carries its request, and only a respec run does.
      const rawRun = (id: string, kind: string, payload: unknown) => sql`
        insert into bounty_run (
          id, organization_id, board_id, started_by, request_id, status, kind,
          source_proposal_id, source_revision, respec,
          selection, rate_card, requested_model, prompt_version
        ) values (
          ${id}, 'org_bounty', 'board_respec', 'user_bounty', ${`request-${id}`},
          'failed', ${kind}, ${kind === "backlog" ? null : proposalId},
          ${kind === "backlog" ? null : 1},
          ${payload === null ? null : sql.json(payload as never)},
          ${sql.json(selection)}, ${sql.json(rateCard)}, 'model-test', 'v1'
        )
      `;
      await assert.rejects(rawRun("run_respec_bare", "respec", null));
      await assert.rejects(rawRun("run_backlog_payload", "backlog", respec));

      // Under its lease, and only from the revision it was asked of.
      await runs.claim("org_bounty", first.run.id, "lease_r", new Date());
      assert.equal(
        (
          await proposals.respecForLease(
            "org_bounty",
            "stale",
            proposalId,
            1,
            change(first.run.id, 1),
          )
        ).status,
        "lost-lease",
      );
      assert.equal(
        (
          await proposals.respecForLease(
            "org_bounty",
            "lease_r",
            proposalId,
            1,
            change(first.run.id, 2),
          )
        ).status,
        "changed",
      );
      const before = (
        await sql`select count(*)::int as count from bounty_spec where proposal_id = ${proposalId}`
      )[0]?.["count"];
      assert.equal(before, 1);

      const written = await proposals.respecForLease(
        "org_bounty",
        "lease_r",
        proposalId,
        1,
        change(first.run.id, 1),
      );
      assert.equal(written.status, "respecced");
      if (written.status !== "respecced") return;
      assert.equal(written.previousComplexity, "M");
      assert.equal(written.proposal.revision, 2);
      assert.equal(written.proposal.specRevision, 2);
      assert.equal(written.proposal.complexity, "M");
      assert.deepEqual(written.proposal.step, trimStep);
      // What sized it stays: the run, the model's size, who set the base.
      assert.equal(written.proposal.runId, "run_respec_sized");
      assert.equal(written.proposal.modelComplexity, "M");
      assert.equal(written.proposal.sizedBy, "model");

      const revision = await specs.get("org_bounty", proposalId, 2);
      assert.equal(revision?.origin, "trim");
      assert.equal(revision?.createdBy, "user_bounty");
      assert.equal(revision?.runId, first.run.id);
      assert.equal(revision?.instruction, "Removed A failed export is retried");
      assert.equal(revision?.actualModel, null);
      assert.deepEqual(revision?.draft, trimmed);
      // The step still counts from the drafted revision.
      assert.equal(
        (await specs.sizedRevision("org_bounty", proposalId, 2))?.revision,
        1,
      );
      assert.equal(
        (await specs.listRevisions("org_bounty", proposalId))[0]?.instruction,
        "Removed A failed export is retried",
      );
      await runs.finish("org_bounty", first.run.id, "lease_r", "succeeded");

      // Once it has ended, the proposal takes another change; one made of
      // the revision before is refused, and so is one of an approval.
      const later = await runs.create("org_bounty", {
        ...runInput("request-respec-3", 1),
        sourceProposalId: proposalId,
      });
      assert.equal(later.ok, true);
      if (!later.ok) return;
      await runs.claim("org_bounty", later.run.id, "lease_l", new Date());
      assert.equal(
        (
          await proposals.respecForLease(
            "org_bounty",
            "lease_l",
            proposalId,
            1,
            change(later.run.id, 1),
          )
        ).status,
        "changed",
      );
      const approved = await proposals.approve(
        "org_bounty",
        proposalId,
        2,
        "user_bounty",
        "off",
      );
      assert.equal(approved.ok, true);
      await sql`update bounty_run set source_revision = 3 where id = ${later.run.id}`;
      assert.equal(
        (
          await proposals.respecForLease(
            "org_bounty",
            "lease_l",
            proposalId,
            3,
            change(later.run.id, 2),
          )
        ).status,
        "changed",
      );
    } finally {
      await connection.close();
    }
  });

  test("a bounty page skips none made in the same millisecond as its last row", async () => {
    // Postgres keeps microseconds, and a page's cursor milliseconds: three
    // bounties inside one millisecond, read two to a page, all come back.
    await sql`
      insert into organization (id, name, slug)
      values ('org_paging', 'Paging Org', 'paging-org')
    `;
    for (const [id, micros] of [
      ["bty_ms_a", 100],
      ["bty_ms_b", 400],
      ["bty_ms_c", 700],
    ] as const) {
      // Computed in SQL: a timestamp sent as a parameter goes through a JS
      // Date, which would cut it to the millisecond before it arrived.
      await sql`
        insert into bounty (id, organization_id, title, created_at)
        values (
          ${id}, 'org_paging', ${id},
          timestamptz '2026-10-03 00:00:00.123Z'
            + ${micros}::int * interval '1 microsecond'
        )
      `;
    }
    const connection = createConnection({ url: scratchUrl() });
    try {
      const bounties = createBountyStore(connection.db);
      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (;;) {
        const page = await bounties.list("org_paging", {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.map(({ id }) => id));
        const last = page.at(-1);
        if (page.length < 2 || last === undefined) break;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      assert.deepEqual(seen, ["bty_ms_c", "bty_ms_b", "bty_ms_a"]);
    } finally {
      await connection.close();
    }
  });

  test("a bounty delete waits for a proposal being written for it, and keeps both", async () => {
    await importIssues([
      ["issue_delete_race", "board_bounty", "1006", "DEMO-6"],
    ]);
    await insertRun("run_delete_race", "request-delete-race", "succeeded");
    const connection = createConnection({ url: scratchUrl() });
    try {
      const bounties = createBountyStore(connection.db);
      let removing: Promise<string> | undefined;
      // The proposal's insert holds a key-share lock on the bounty until
      // it commits; the delete is asked for while it is still open.
      await sql.begin(async (tx) => {
        await insertProposal(
          "proposal_delete_race",
          "run_delete_race",
          "issue_delete_race",
          tx,
        );
        removing = bounties.remove("org_bounty", "issue_delete_race");
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      assert.equal(await removing, "in-use");
      const [kept] = await sql<{ proposals: number; bounties: number }[]>`
        select
          (select count(*)::int from bounty_proposal where id = 'proposal_delete_race') as proposals,
          (select count(*)::int from bounty where id = 'issue_delete_race') as bounties
      `;
      assert.deepEqual(kept, { proposals: 1, bounties: 1 });

      // A bounty nothing is built on goes.
      await importIssues([
        ["issue_delete_free", "board_bounty", "1007", "DEMO-7"],
      ]);
      assert.equal(
        await bounties.remove("org_bounty", "issue_delete_free"),
        "removed",
      );
      assert.equal(
        await bounties.remove("org_bounty", "issue_delete_free"),
        "not-found",
      );
    } finally {
      await connection.close();
    }
  });

  test("a bounty has one sandbox, which keeps it, and a repository is linked to it once", async () => {
    await importIssues([
      ["issue_sandbox", "board_bounty", "1008", "DEMO-8"],
      ["issue_sandbox_race", "board_bounty", "1009", "DEMO-9"],
    ]);
    await sql`insert into github_connection (id, organization_id, installation_id, account_login, account_type, repository_selection, permissions) values ('ghc_sandbox', 'org_bounty', '993', 'example', 'Organization', 'all', '{}')`;
    await sql`insert into github_repo (id, organization_id, connection_id, role, external_id, full_name, default_branch) values ('ghr_sandbox_a', 'org_bounty', 'ghc_sandbox', 'source', '994', 'example/a', 'main'), ('ghr_sandbox_b', 'org_bounty', 'ghc_sandbox', 'source', '995', 'example/b', 'main')`;
    const connection = createConnection({ url: scratchUrl() });
    try {
      const bounties = createBountyStore(connection.db);
      const sandboxes = createSandboxStore(connection.db);

      // Two at once for one bounty: one is made, the other meets it.
      const made = await Promise.all(
        [0, 1].map(() =>
          sandboxes.create("org_bounty", {
            bountyId: "issue_sandbox",
            sourceRepoId: null,
          }),
        ),
      );
      const sandbox = made.find((result) => result.ok)?.sandbox;
      assert.ok(sandbox);
      assert.deepEqual(
        made.filter((result) => !result.ok),
        [{ ok: false, reason: "bounty_has_sandbox" }],
      );

      // The bounty is kept while its sandbox stands, the foreign key never
      // reached, and it reads with the sandbox it has.
      assert.equal(
        await bounties.remove("org_bounty", "issue_sandbox"),
        "in-use",
      );
      assert.deepEqual(
        (await bounties.get("org_bounty", "issue_sandbox"))?.sandbox,
        {
          id: sandbox.id,
          status: "draft",
          currentVersionId: null,
          expiresAt: null,
          sourceRepoId: null,
          build: null,
        },
      );

      // Two links at once: the second waits on the first's lock, then sees
      // its link rather than meeting it as a duplicate key.
      const links = await Promise.all([
        sandboxes.linkSource("org_bounty", sandbox.id, "ghr_sandbox_a"),
        sandboxes.linkSource("org_bounty", sandbox.id, "ghr_sandbox_b"),
      ]);
      assert.deepEqual(
        links.map((result) => (result.ok ? "ok" : result.reason)).sort(),
        ["ok", "source_linked"],
      );
      const linked = (await sandboxes.get("org_bounty", sandbox.id))
        ?.sourceRepoId;
      assert.ok(linked === "ghr_sandbox_a" || linked === "ghr_sandbox_b");
      assert.equal(
        (await bounties.get("org_bounty", "issue_sandbox"))?.sandbox
          ?.sourceRepoId,
        linked,
      );

      // A delete asked for while a sandbox is being made waits for it, as
      // it does for a proposal, and keeps both.
      let removing: Promise<string> | undefined;
      await sql.begin(async (tx) => {
        await tx`
          insert into sandbox (id, organization_id, bounty_id, slug)
          values ('sbx_delete_race', 'org_bounty', 'issue_sandbox_race', 'race00000001')
        `;
        removing = bounties.remove("org_bounty", "issue_sandbox_race");
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      assert.equal(await removing, "in-use");
      const [kept] = await sql<{ sandboxes: number; bounties: number }[]>`
        select
          (select count(*)::int from sandbox where id = 'sbx_delete_race') as sandboxes,
          (select count(*)::int from bounty where id = 'issue_sandbox_race') as bounties
      `;
      assert.deepEqual(kept, { sandboxes: 1, bounties: 1 });
    } finally {
      await connection.close();
    }
  });

  test("bounties written at once are each saved, under ids of their own", async () => {
    await sql`
      insert into organization (id, name, slug)
      values ('org_numbers', 'Numbers Org', 'numbers-org')
    `;
    const connection = createConnection({ url: scratchUrl() });
    try {
      const bounties = createBountyStore(connection.db);
      const created = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          bounties.create("org_numbers", "user_bounty", {
            title: `Bounty ${index}`,
            description: "",
            stack: [],
          }),
        ),
      );
      const ids = created.map(({ id }) => id);
      assert.equal(new Set(ids).size, 5);
      assert.ok(ids.every((id) => id.startsWith("bty_")));
    } finally {
      await connection.close();
    }
  });
});
