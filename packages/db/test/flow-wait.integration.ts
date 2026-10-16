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
    const run = (id: string, kind: string, planned = "[]") => sql`
      insert into bounty_run (
        id, organization_id, bounty_id, kind, request_id, status, selection,
        rate_card, requested_model, prompt_version, planned, created_at,
        finished_at
      ) values (
        ${id}, 'org_flow', 'bty_flow', ${kind}, ${`req_${id}`}, 'succeeded', '{}'::jsonb,
        '{}'::jsonb, 'model', 'v1', ${planned}::jsonb, ${T0}, ${at(60)}
      )
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
    `;
    assert.deepEqual(
      rows.map((row) => row.seconds),
      [20],
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
