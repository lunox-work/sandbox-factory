/**
 * The wait views read against Postgres, since what they measure is their
 * SQL: which runs count, and from which timestamp to which.
 *
 * Outside the ordinary test glob, as the bounty concurrency checks are: it
 * creates and drops a database. Run it with
 * `npm run test:bounty-concurrency -w @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_flow_wait_test";

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

/** A Sunday evening in UTC, which is already Monday east of it. */
const T0 = new Date("2026-10-11T20:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("flow wait views", () => {
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
    sql = postgres(scratchUrl(), { max: 1 });
    await sql`
      insert into organization (id, name, slug)
      values ('org_flow', 'Flow Org', 'flow-org')
    `;
    await sql`
      insert into bounty (id, organization_id, title)
      values ('bty_flow', 'org_flow', 'Fix the login')
    `;
    const run = (
      id: string,
      kind: string,
      {
        bountyId = "bty_flow",
        createdAt = T0,
        written = null,
      }: { bountyId?: string; createdAt?: Date; written?: Date | null } = {},
    ) => sql`
      insert into bounty_run (
        id, organization_id, bounty_id, kind, request_id, status, selection,
        rate_card, requested_model, prompt_version, planned, created_at,
        finished_at, source_revision, proposal_written_at
      ) values (
        ${id}, 'org_flow', ${bountyId}, ${kind}, ${`req_${id}`}, 'succeeded', '{}'::jsonb,
        '{}'::jsonb, 'model', 'v1', '[]'::jsonb, ${createdAt},
        ${new Date(createdAt.getTime() + 60_000)},
        ${kind === "reprice" ? 1 : null}, ${written}
      )
    `;
    const proposal = (id: string, runId: string, bountyId: string) => sql`
      insert into bounty_proposal (
        id, organization_id, run_id, spec_hash, rate_card, model_complexity,
        model_confidence, model_rationale, actual_model, prompt_version,
        complexity, bounty_id, created_at
      ) values (
        ${id}, 'org_flow', ${runId}, ${"0".repeat(64)}, '{}'::jsonb, 'M', 'high',
        'r', 'model', 'v1', 'unsized', ${bountyId}, ${at(20)}
      )
    `;
    const spec = (
      proposalId: string,
      revision: number,
      runId: string,
      createdAt: Date,
    ) => sql`
      insert into bounty_spec (
        id, organization_id, proposal_id, revision, spec_hash,
        spec_hash_version, draft, origin, run_id, created_at
      ) values (
        ${`bsp_${runId}`}, 'org_flow', ${proposalId}, ${revision}, ${"0".repeat(64)},
        1, '{}'::jsonb, 'draft', ${runId}, ${createdAt}
      )
    `;
    await sql`
      insert into bounty (id, organization_id, title) values
        ('bty_repriced', 'org_flow', 'Fix the logout'),
        ('bty_legacy', 'org_flow', 'Fix the signup'),
        ('bty_bare', 'org_flow', 'Fix the reset')
    `;
    // Sized: its proposal is written 20 s in, the run ends at 60 s.
    await run("brn_sized", "bounty");
    await sql`
      insert into bounty_proposal (
        id, organization_id, run_id, spec_hash, rate_card, model_complexity,
        model_confidence, model_rationale, actual_model, prompt_version,
        complexity, bounty_id, created_at
      ) values (
        'bpr_sized', 'org_flow', 'brn_sized', ${"0".repeat(64)}, '{}'::jsonb, 'M', 'high',
        'r', 'model', 'v1', 'unsized', 'bty_flow', ${at(20)}
      )
    `;
    // Skipped for a live proposal: it succeeds, and writes none.
    await run("brn_skipped", "bounty");
    // Priced 20 s in, then re-priced by a run asked for at 3500 s, which
    // writes at 3600 s: the proposal keeps the first's `created_at` and
    // takes the second's `run_id`.
    await run("brn_first", "bounty", {
      bountyId: "bty_repriced",
      written: at(20),
    });
    await run("brn_reprice", "reprice", {
      bountyId: "bty_repriced",
      createdAt: at(3500),
      written: at(3600),
    });
    await proposal("bpr_repriced", "brn_reprice", "bty_repriced");
    // The same, from before runs kept their write: each run's spec
    // revision is the write. A re-price that wrote no spec is no price.
    await run("brn_legacy_first", "bounty", { bountyId: "bty_legacy" });
    await run("brn_legacy_reprice", "reprice", {
      bountyId: "bty_legacy",
      createdAt: at(3500),
    });
    await proposal("bpr_legacy", "brn_legacy_reprice", "bty_legacy");
    await spec("bpr_legacy", 1, "brn_legacy_first", at(20));
    await spec("bpr_legacy", 2, "brn_legacy_reprice", at(3600));
    await run("brn_bare_first", "bounty", { bountyId: "bty_bare" });
    await run("brn_bare_reprice", "reprice", {
      bountyId: "bty_bare",
      createdAt: at(3500),
    });
    await proposal("bpr_bare", "brn_bare_reprice", "bty_bare");
    // An analysis run that waited 100 s for a worker and ran for 6 s.
    await sql`
      insert into analysis_run (
        id, organization_id, tool, tool_version, params, params_hash, status,
        created_at, started_at, finished_at
      ) values (
        'arn_flow', 'org_flow', 'graphify', 'graphify@1', '{}'::jsonb, 'p',
        'succeeded', ${T0}, ${at(100)}, ${at(106)}
      )
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

  test("a price is the click to the proposal written, and a run that wrote none is no price", async () => {
    const rows = await sql<{ seconds: number }[]>`
      select seconds from flow_wait_sample where flow = 'price'
      order by seconds
    `;
    // The sized run, and each first run and re-price: 100 s from the
    // re-price's click, never the first's `created_at` before it.
    assert.deepEqual(
      rows.map((row) => row.seconds),
      [20, 20, 20, 100, 100],
    );
  });

  test("a run's time is from its claim, its queue from being asked for", async () => {
    const rows = await sql<{ flow: string; seconds: number }[]>`
      select flow, seconds from flow_wait_sample
      where flow in ('queue:graphify', 'run:graphify') order by flow
    `;
    assert.deepEqual(
      rows.map(({ flow, seconds }) => ({ flow, seconds })),
      [
        { flow: "queue:graphify", seconds: 100 },
        { flow: "run:graphify", seconds: 6 },
      ],
    );
  });

  test("a week begins on a Monday in UTC, whatever the session's zone", async () => {
    await sql.begin(async (tx) => {
      await tx`set local time zone 'Asia/Singapore'`;
      const rows = await tx<{ week: Date }[]>`
        select distinct week from flow_wait
      `;
      assert.deepEqual(
        rows.map((row) => row.week.toISOString()),
        ["2026-10-05T00:00:00.000Z"],
      );
    });
  });
});
