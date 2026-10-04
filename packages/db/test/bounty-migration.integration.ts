/**
 * Migration 0045's backfill against Postgres: tickets become bounties, each
 * sandbox is given the one bounty it now belongs to, and the JSON a run and
 * a profile keep names the bounty the way the columns do.
 *
 * Hand-written SQL is what drizzle-kit cannot check, so it is checked here:
 * a database is migrated to 0044, seeded the way 0044 left real ones, and
 * then taken to the head. Outside the ordinary test glob, like the
 * concurrency suite, since it creates and drops a database; it runs with
 * `npm run test:bounty-concurrency --workspace @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_bounty_migration_test";
/** The migration under test; everything before it is the starting point. */
const UNDER_TEST = 45;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A copy of `drizzle/` that stops just before the migration under test. */
async function migrationsBefore(index: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "sandbox-factory-migrations-"));
  await cp("drizzle", folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const later = journal.entries.filter((entry) => entry.idx >= index);
  assert.ok(later.length > 0, "the migration under test is in the journal");
  for (const entry of later) await rm(join(folder, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx < index);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

describe("migration 0045: tickets become bounties", () => {
  let sql: postgres.Sql;
  let folder: string | undefined;

  before(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
      await admin.unsafe(`create database ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
    folder = await migrationsBefore(UNDER_TEST);
    await runMigrations({ url: scratchUrl(), migrationsFolder: folder });

    sql = postgres(scratchUrl(), { max: 1, onnotice: () => {} });
    await sql`
      insert into organization (id, name, slug)
      values ('org_a', 'A', 'org-a'), ('org_b', 'B', 'org-b')
    `;
    await sql`
      insert into ticket (id, organization_id, number, title) values
        ('tkt_1', 'org_a', 1, 'One'),
        ('tkt_2', 'org_a', 2, 'Two'),
        ('tkt_3', 'org_a', 3, 'Three'),
        ('tkt_7', 'org_a', 7, 'Seven')
    `;
    await sql`
      insert into sandbox (id, organization_id, slug, created_at) values
        ('sbx_old', 'org_a', 'old000000001', ${day(1)}),
        ('sbx_new', 'org_a', 'new000000001', ${day(2)}),
        ('sbx_t3', 'org_a', 't30000000001', ${day(3)}),
        ('sbx_none', 'org_a', 'none00000001', ${day(4)}),
        ('sbx_b', 'org_b', 'b00000000001', ${day(5)})
    `;
    await sql`
      insert into sandbox_ticket (sandbox_id, ticket_id) values
        ('sbx_old', 'tkt_1'), ('sbx_old', 'tkt_2'),
        ('sbx_new', 'tkt_2'),
        ('sbx_t3', 'tkt_1'), ('sbx_t3', 'tkt_3')
    `;
    await sql`
      insert into sandbox_version (id, sandbox_id, version, title, spec_summary, complexity) values
        ('sbv_new_1', 'sbx_new', 1, 'New, first', 'S', 'M'),
        ('sbv_new_2', 'sbx_new', 2, 'New, second', 'S', 'M'),
        ('sbv_b', 'sbx_b', 1, ${"x".repeat(300)}, 'S', 'M')
    `;
    const selection = sql.json({ batchSize: 5, scanLimit: 20 });
    const rateCard = sql.json({
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    });
    await sql`
      insert into bounty_run (
        id, organization_id, request_id, selection, rate_card,
        requested_model, prompt_version, kind, ticket_id, status, planned, outcomes
      ) values
        ('run_1', 'org_a', 'request-1', ${selection}, ${rateCard}, 'model', 'v1',
          'ticket', 'tkt_1', 'succeeded',
          ${sql.json([{ ticketId: "tkt_1", issueKey: "T-1" }, { issueId: "jri_9" }])},
          ${sql.json([{ ticketId: "tkt_1", status: "proposed" }])}),
        ('run_3', 'org_a', 'request-3', ${selection}, ${rateCard}, 'model', 'v1',
          'ticket', 'tkt_3', 'running', '[]', '[]')
    `;
    await sql`
      insert into bounty_proposal (
        id, organization_id, run_id, ticket_id, spec_hash, rate_card,
        model_complexity, model_confidence, model_rationale, actual_model,
        prompt_version, complexity, amount_minor, currency
      ) values (
        'bpr_1', 'org_a', 'run_1', 'tkt_1', ${"a".repeat(64)}, ${rateCard},
        'M', 'high', 'A few files.', 'model', 'v1', 'M', 200, 'USD'
      )
    `;
    const profiled = { issueType: "Bug", priority: null };
    await sql`
      insert into bounty_profile (
        id, organization_id, proposal_id, spec_revision, spec_hash, ticket, status, profile
      ) values (
        'bpf_1', 'org_a', 'bpr_1', 1, ${"s".repeat(64)}, ${sql.json(profiled)},
        'ready', ${sql.json({ version: "profile-v1", ticket: profiled, slice: { files: 1 } })}
      )
    `;
    await sql.end();

    await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
    sql = postgres(scratchUrl(), { max: 1, onnotice: () => {} });
  });

  after(async () => {
    await sql?.end();
    if (folder !== undefined)
      await rm(folder, { recursive: true, force: true });
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
  });

  test("each sandbox is given one bounty, and none is lost", async () => {
    const rows = await sql<
      { id: string; bountyId: string; number: number; title: string }[]
    >`
      select s.id, s.bounty_id as "bountyId", b.number, b.title
      from sandbox s join bounty b on b.id = s.bounty_id
      order by s.created_at
    `;
    const by = new Map(rows.map((row) => [row.id, row]));
    assert.equal(rows.length, 5);
    // The lowest-numbered ticket it linked that no older sandbox claimed.
    assert.equal(by.get("sbx_old")?.bountyId, "tkt_1");
    assert.equal(by.get("sbx_t3")?.bountyId, "tkt_3");
    // Its only ticket went to an older sandbox, which kept another: it gets
    // a bounty of its own, titled after its newest version and numbered
    // after the organization's highest. The rule the migration documents.
    assert.match(by.get("sbx_new")?.bountyId ?? "", /^bty_[0-9a-f-]{36}$/);
    assert.deepEqual(
      [by.get("sbx_new")?.number, by.get("sbx_new")?.title],
      [8, "New, second"],
    );
    // Nothing linked and no version: named after its slug.
    assert.deepEqual(
      [by.get("sbx_none")?.number, by.get("sbx_none")?.title],
      [9, "Sandbox none00000001"],
    );
    // Numbered within its own organization, with a title cut to fit.
    assert.equal(by.get("sbx_b")?.number, 1);
    assert.equal(by.get("sbx_b")?.title, "x".repeat(255));

    // Every ticket stays a bounty, linked or not.
    const [counted] = await sql<{ tickets: number; unlinked: string[] }[]>`
      select
        (select count(*)::int from bounty where id like 'tkt_%') as tickets,
        (select array_agg(id order by id) from bounty b
          where id like 'tkt_%'
          and not exists (select 1 from sandbox s where s.bounty_id = b.id)) as unlinked
    `;
    assert.deepEqual(counted, { tickets: 4, unlinked: ["tkt_2", "tkt_7"] });
    const [linkTable] = await sql<{ name: string | null }[]>`
      select to_regclass('sandbox_ticket')::text as name
    `;
    assert.equal(linkTable?.name, null);
  });

  test("a run's kind, plan and outcomes, and a profile, name the bounty", async () => {
    const runs = await sql<
      {
        id: string;
        kind: string;
        bountyId: string;
        planned: unknown;
        outcomes: unknown;
      }[]
    >`
      select id, kind, bounty_id as "bountyId", planned, outcomes
      from bounty_run order by id
    `;
    assert.deepEqual(
      [...runs],
      [
        {
          id: "run_1",
          kind: "bounty",
          bountyId: "tkt_1",
          planned: [
            { bountyId: "tkt_1", issueKey: "T-1" },
            { issueId: "jri_9" },
          ],
          outcomes: [{ bountyId: "tkt_1", status: "proposed" }],
        },
        {
          id: "run_3",
          kind: "bounty",
          bountyId: "tkt_3",
          planned: [],
          outcomes: [],
        },
      ],
    );
    const [profile] = await sql<{ bounty: unknown; profile: unknown }[]>`
      select bounty, profile from bounty_profile where id = 'bpf_1'
    `;
    const profiled = { issueType: "Bug", priority: null };
    assert.deepEqual(profile, {
      bounty: profiled,
      profile: { version: "profile-v1", bounty: profiled, slice: { files: 1 } },
    });
    const [proposal] = await sql<{ bountyId: string }[]>`
      select bounty_id as "bountyId" from bounty_proposal where id = 'bpr_1'
    `;
    assert.equal(proposal?.bountyId, "tkt_1");
  });

  test("the constraints hold after the backfill", async () => {
    // A second sandbox for a bounty, and a bounty run with no bounty.
    await assert.rejects(
      sql`
        insert into sandbox (id, organization_id, bounty_id, slug)
        values ('sbx_second', 'org_a', 'tkt_1', 'second000001')
      `,
      /sandbox_bounty_id_unique/,
    );
    await assert.rejects(
      sql`
        insert into bounty_run (
          id, organization_id, request_id, selection, rate_card,
          requested_model, prompt_version, kind
        ) values (
          'run_bad', 'org_a', 'request-bad', '{}', '{}', 'model', 'v1', 'bounty'
        )
      `,
      /bounty_run_scope_check/,
    );
    // The one-active-sizing rule now reads the renamed kind: run_3 is still
    // sizing tkt_3, so a second is refused.
    await assert.rejects(
      sql`
        insert into bounty_run (
          id, organization_id, request_id, selection, rate_card,
          requested_model, prompt_version, kind, bounty_id
        ) values (
          'run_dup', 'org_a', 'request-dup', '{}', '{}', 'model', 'v1', 'bounty', 'tkt_3'
        )
      `,
      /bounty_run_bounty_active_unique/,
    );
  });
});
