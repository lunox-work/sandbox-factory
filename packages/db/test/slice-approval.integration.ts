/**
 * Slice approvals against Postgres, since what they guard is their SQL.
 *
 * 0071: profiles measured before approvals were asked for keep what they
 * were, and only a measured row may await an approval. Then the store: the
 * first approval stands and is answered to a second, and the preparer's
 * hold of a profile measured ready before approvals never undoes an
 * approval that landed first, in either order.
 *
 * Outside the ordinary test glob, like the concurrency suite, since it
 * creates and drops a database; it runs with
 * `npm run test:bounty-concurrency --workspace @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { createBountyProfileStore, createConnection } from "../src/index.js";
import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_slice_approval_test";
/** The migration under test; everything before it is the starting point. */
const UNDER_TEST = 71;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

async function admin(statement: string): Promise<void> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

/** A copy of `drizzle/` that stops just before the migration under test. */
async function migrationsBefore(index: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "sandbox-factory-migrations-"));
  await cp("drizzle", folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries.filter((entry) => entry.idx >= index))
    await rm(join(folder, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx < index);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

const measured = { version: "profile-v1" };

describe("slice approvals", () => {
  let sql: postgres.Sql;
  let folder: string | undefined;

  /** A profile of `bpr_1`'s revision `revision`, measured from `arn_slice`. */
  const profile = (
    id: string,
    revision: number,
    status: string,
    columns: { errorCode?: string } = {},
  ) => sql`
    insert into bounty_profile (
      id, organization_id, proposal_id, spec_revision, spec_hash, status,
      error_code, slice_run_id, profile
    ) values (
      ${id}, 'org_a', 'bpr_1', ${revision}, ${"0".repeat(64)}, ${status},
      ${columns.errorCode ?? null}, 'arn_slice',
      ${status === "ready" || status === "awaiting_approval" ? sql.json(measured) : null}
    )
  `;
  const read = async (id: string) =>
    (
      await sql<
        {
          status: string;
          profile: unknown;
          slice_approved_by: string | null;
          slice_approved_at: Date | null;
          transitions: { status: string }[];
        }[]
      >`
        select status, profile, slice_approved_by, slice_approved_at, transitions
        from bounty_profile where id = ${id}
      `
    )[0];
  const withStore = async <T>(
    use: (store: ReturnType<typeof createBountyProfileStore>) => Promise<T>,
  ) => {
    // Closed after, or dropping the scratch database waits on it forever.
    const connection = createConnection({ url: scratchUrl() });
    try {
      return await use(createBountyProfileStore(connection.db));
    } finally {
      await connection.close();
    }
  };

  before(async () => {
    await admin(`drop database if exists ${SCRATCH_DB}`);
    await admin(`create database ${SCRATCH_DB}`);
    folder = await migrationsBefore(UNDER_TEST);
    await runMigrations({ url: scratchUrl(), migrationsFolder: folder });
    sql = postgres(scratchUrl(), { max: 1, onnotice: () => {} });
    await sql`
      insert into "user" (id, name, email, username, display_username) values
        ('usr_a', 'A', 'a@example.test', 'user-a', 'user-a'),
        ('usr_b', 'B', 'b@example.test', 'user-b', 'user-b')
    `;
    await sql`
      insert into organization (id, name, slug) values ('org_a', 'A', 'org-a')
    `;
    await sql`
      insert into bounty (id, organization_id, title)
      values ('bty_1', 'org_a', 'Fix the login')
    `;
    await sql`
      insert into bounty_run (
        id, organization_id, bounty_id, kind, request_id, status, selection,
        rate_card, requested_model, prompt_version, planned
      ) values (
        'brn_1', 'org_a', 'bty_1', 'bounty', 'req_1', 'succeeded', '{}'::jsonb,
        '{}'::jsonb, 'model', 'v1', '[]'::jsonb
      )
    `;
    await sql`
      insert into bounty_proposal (
        id, organization_id, run_id, spec_hash, rate_card, model_complexity,
        model_confidence, model_rationale, actual_model, prompt_version,
        complexity, bounty_id
      ) values (
        'bpr_1', 'org_a', 'brn_1', ${"0".repeat(64)}, '{}'::jsonb, 'M', 'high',
        'r', 'model', 'v1', 'unsized', 'bty_1'
      )
    `;
    await sql`
      insert into analysis_run (
        id, organization_id, tool, tool_version, params, params_hash, status
      ) values
        ('arn_slice', 'org_a', 'slice', 'slice@1', '{}'::jsonb, 'p', 'succeeded')
    `;
    // As 0070 left them: measured, in flight and failed.
    await profile("bpf_ready", 1, "ready");
    await profile("bpf_queued", 2, "queued");
    await profile("bpf_failed", 3, "failed", { errorCode: "slice_failed" });
    await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
  });

  after(async () => {
    await sql?.end();
    if (folder !== undefined) await rm(folder, { recursive: true });
    await admin(`drop database if exists ${SCRATCH_DB}`);
  });

  test("0071 keeps every profile as it was, unapproved, and only a measured one awaits approval", async () => {
    const rows = await sql<
      { id: string; status: string; measured: boolean; approved: boolean }[]
    >`
      select id, status, profile is not null as measured,
        slice_approved_by is not null or slice_approved_at is not null as approved
      from bounty_profile order by id
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          id: "bpf_failed",
          status: "failed",
          measured: false,
          approved: false,
        },
        {
          id: "bpf_queued",
          status: "queued",
          measured: false,
          approved: false,
        },
        { id: "bpf_ready", status: "ready", measured: true, approved: false },
      ],
    );
    await profile("bpf_waiting", 4, "awaiting_approval");
    await assert.rejects(
      sql`
        insert into bounty_profile (
          id, organization_id, proposal_id, spec_revision, spec_hash, status
        ) values (
          'bpf_bare', 'org_a', 'bpr_1', 5, ${"0".repeat(64)}, 'awaiting_approval'
        )
      `,
      (error: { constraint_name?: string }) =>
        error.constraint_name === "bounty_profile_ready_check",
    );
  });

  test("the first approval stands, a second is answered with it, and another slice run is not approved", async () => {
    await withStore(async (store) => {
      assert.equal(
        await store.approveSlice("org_a", "bpf_waiting", "arn_other", "usr_a"),
        null,
      );
      assert.equal((await read("bpf_waiting"))?.status, "awaiting_approval");
      assert.deepEqual(
        await store.approveSlice("org_a", "bpf_waiting", "arn_slice", "usr_a"),
        { approvedBy: "usr_a" },
      );
      const first = await read("bpf_waiting");
      assert.equal(first?.status, "ready");
      assert.deepEqual(first?.profile, measured);
      assert.equal(first?.slice_approved_by, "usr_a");
      assert.deepEqual(
        first?.transitions.map((move) => move.status),
        ["ready"],
      );
      // Two at once: the second finds the first's approval and is told it.
      assert.deepEqual(
        await store.approveSlice("org_a", "bpf_waiting", "arn_slice", "usr_b"),
        { approvedBy: "usr_a" },
      );
      const again = await read("bpf_waiting");
      assert.equal(again?.slice_approved_by, "usr_a");
      assert.deepEqual(again?.slice_approved_at, first?.slice_approved_at);
      assert.equal(again?.transitions.length, 1);
      // Another organization's approval approves nothing.
      assert.equal(
        await store.approveSlice("org_b", "bpf_ready", "arn_slice", "usr_a"),
        null,
      );
      assert.equal(
        await store.approveSlice("org_a", "bpf_queued", "arn_slice", "usr_a"),
        null,
      );
    });
    // The approver's account gone, the approval stands with no one named.
    await sql`delete from "user" where id = 'usr_a'`;
    await withStore(async (store) => {
      assert.deepEqual(
        await store.approveSlice("org_a", "bpf_waiting", "arn_slice", "usr_b"),
        { approvedBy: null },
      );
    });
    assert.notEqual((await read("bpf_waiting"))?.slice_approved_at, null);
  });

  test("an approval that lands before the preparer's hold is never undone", async () => {
    await withStore(async (store) => {
      // Measured ready before approvals; approved, then the stale hold.
      assert.deepEqual(
        await store.approveSlice("org_a", "bpf_ready", "arn_slice", "usr_b"),
        { approvedBy: "usr_b" },
      );
      assert.equal(await store.holdSlice("org_a", "bpf_ready"), false);
      const row = await read("bpf_ready");
      assert.equal(row?.status, "ready");
      assert.equal(row?.slice_approved_by, "usr_b");
      // Already ready, it moved nowhere to be told of.
      assert.deepEqual(row?.transitions, []);
    });
  });

  test("a hold before the approval waits for it, and the approval makes it ready", async () => {
    await sql`
      update bounty_profile set status = 'ready', profile = ${sql.json(measured)}
      where id = 'bpf_queued'
    `;
    await withStore(async (store) => {
      assert.equal(await store.holdSlice("org_a", "bpf_queued"), true);
      const held = await read("bpf_queued");
      assert.equal(held?.status, "awaiting_approval");
      assert.deepEqual(held?.profile, measured);
      // Held already: a second pass holds nothing.
      assert.equal(await store.holdSlice("org_a", "bpf_queued"), false);
      assert.deepEqual(
        await store.approveSlice("org_a", "bpf_queued", "arn_slice", "usr_b"),
        { approvedBy: "usr_b" },
      );
      const approved = await read("bpf_queued");
      assert.equal(approved?.status, "ready");
      assert.notEqual(approved?.slice_approved_at, null);
      assert.deepEqual(
        approved?.transitions.map((move) => move.status),
        ["awaiting_approval", "ready"],
      );
    });
  });
});
