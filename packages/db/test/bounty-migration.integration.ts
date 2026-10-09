/**
 * The bounty migrations' backfills against Postgres.
 *
 * 0045: tickets become bounties, each sandbox is given the one bounty it now
 * belongs to, and the JSON a run and a profile keep names the bounty the way
 * the columns do. 0046: a bounty's issue type, priority and labels go, and
 * each proposal and spec revision still current moves to the spec hash that
 * no longer reads the type. 0050: an approved proposal is its first version,
 * approved when it was decided. 0059: a proposal's one snapshot becomes the
 * one repository it touches, and a bounty and a board name none.
 *
 * Hand-written SQL is what drizzle-kit cannot check, so it is checked here:
 * a database is migrated to just before the migration, seeded the way the
 * one before left real ones, and then taken through it. Outside the ordinary
 * test glob, like the concurrency suite, since it creates and drops
 * databases; it runs with
 * `npm run test:bounty-concurrency --workspace @sandbox-factory/db`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";
import { bountySpecHash, normalizeSpecText } from "sandbox-factory";

import { runMigrations } from "../src/migrate.js";

const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_bounty_migration_test";
const TEXT_SCRATCH_DB = "sandbox_factory_bounty_text_migration_test";
const VERSION_SCRATCH_DB = "sandbox_factory_proposal_version_migration_test";
const REPOSITORIES_SCRATCH_DB =
  "sandbox_factory_proposal_repositories_migration_test";
/** The migration under test; everything before it is the starting point. */
const UNDER_TEST = 45;

function scratchUrl(database = SCRATCH_DB): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreate(database: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${database}`);
    await admin.unsafe(`create database ${database}`);
  } finally {
    await admin.end();
  }
}

async function drop(database: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${database}`);
  } finally {
    await admin.end();
  }
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
  let through: string | undefined;

  before(async () => {
    await recreate(SCRATCH_DB);
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

    // Through 0045 and no further: a later migration may change what 0045
    // left, and this checks 0045.
    through = await migrationsBefore(UNDER_TEST + 1);
    await runMigrations({ url: scratchUrl(), migrationsFolder: through });
    sql = postgres(scratchUrl(), { max: 1, onnotice: () => {} });
  });

  after(async () => {
    await sql?.end();
    for (const copy of [folder, through])
      if (copy !== undefined) await rm(copy, { recursive: true, force: true });
    await drop(SCRATCH_DB);
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

/** Version 1 of `bountySpecHash`, which hashed the issue type as well. */
function hashV1(title: string, description: string, issueType: string) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [title, description, issueType].map((field) =>
          normalizeSpecText(field),
        ),
      ),
    )
    .digest("hex");
}

describe("migration 0046: a bounty's type, priority and labels go", () => {
  let sql: postgres.Sql;
  let folder: string | undefined;
  /*
    A bounty whose text exercises the normalization: CRLF, trailing tabs and
    Unicode spaces, a quote, a control character and a character outside the
    Basic Multilingual Plane.
  */
  const awkward = {
    title: ' Quote " here\u00a0',
    description: "One\t\r\nTwo\u2003\r\n\u0001 \u{1F600}\n\n",
    issueType: "Bug\u3000",
  };

  before(async () => {
    await recreate(TEXT_SCRATCH_DB);
    folder = await migrationsBefore(46);
    await runMigrations({
      url: scratchUrl(TEXT_SCRATCH_DB),
      migrationsFolder: folder,
    });

    sql = postgres(scratchUrl(TEXT_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
    await sql`insert into organization (id, name, slug) values ('org_a', 'A', 'org-a')`;
    await sql`
      insert into bounty (id, organization_id, number, title, description, issue_type, priority, labels)
      values
        ('bty_1', 'org_a', 1, 'Fix login', 'Steps', 'Bug', 'High', ${sql.json(["auth"])}),
        ('bty_2', 'org_a', 2, 'Edited since', 'Now says more', 'Task', null, '[]'),
        ('bty_3', 'org_a', 3, ${awkward.title}, ${awkward.description}, ${awkward.issueType}, null, '[]')
    `;
    const rateCard = sql.json({
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    });
    for (const n of [1, 2, 3]) {
      await sql`
        insert into bounty_run (
          id, organization_id, request_id, selection, rate_card,
          requested_model, prompt_version, kind, bounty_id, status
        ) values (
          ${`run_${n}`}, 'org_a', ${`request-${n}`}, '{}', ${rateCard},
          'model', 'v1', 'bounty', ${`bty_${n}`}, 'succeeded'
        )
      `;
    }
    const proposals: [string, string, string][] = [
      ["bpr_1", "bty_1", hashV1("Fix login", "Steps", "Bug")],
      // Priced before the bounty was edited: already stale.
      ["bpr_2", "bty_2", hashV1("Edited since", "Said less", "Task")],
      [
        "bpr_3",
        "bty_3",
        hashV1(awkward.title, awkward.description, awkward.issueType),
      ],
    ];
    for (const [id, bountyId, specHash] of proposals) {
      await sql`
        insert into bounty_proposal (
          id, organization_id, run_id, bounty_id, spec_hash, rate_card,
          model_complexity, model_confidence, model_rationale, actual_model,
          prompt_version, complexity, amount_minor, currency
        ) values (
          ${id}, 'org_a', ${`run_${bountyId.slice(4)}`}, ${bountyId}, ${specHash},
          ${rateCard}, 'M', 'high', 'A few files.', 'model', 'v1', 'M', 200, 'USD'
        )
      `;
    }
    const draft = sql.json({ summary: "S" });
    await sql`
      insert into bounty_spec (
        id, organization_id, proposal_id, revision, spec_hash, spec_hash_version, draft, origin
      ) values
        ('bsp_1', 'org_a', 'bpr_1', 1, ${hashV1("Fix login", "Older steps", "Bug")}, 1, ${draft}, 'draft'),
        ('bsp_2', 'org_a', 'bpr_1', 2, ${hashV1("Fix login", "Steps", "Bug")}, 1, ${draft}, 'expand')
    `;
    await sql`
      insert into bounty_profile (
        id, organization_id, proposal_id, spec_revision, spec_hash, bounty, status
      ) values (
        'bpf_1', 'org_a', 'bpr_1', 2, ${"s".repeat(64)},
        ${sql.json({ issueType: "Bug", priority: "High" })}, 'queued'
      )
    `;
    await sql.end();

    await runMigrations({
      url: scratchUrl(TEXT_SCRATCH_DB),
      migrationsFolder: "drizzle",
    });
    sql = postgres(scratchUrl(TEXT_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
  });

  after(async () => {
    await sql?.end();
    if (folder !== undefined)
      await rm(folder, { recursive: true, force: true });
    await drop(TEXT_SCRATCH_DB);
  });

  test("a proposal still current moves to the hash without the type", async () => {
    const rows = await sql<
      { id: string; specHash: string; specHashVersion: number }[]
    >`
      select id, spec_hash as "specHash", spec_hash_version as "specHashVersion"
      from bounty_proposal order by id
    `;
    assert.deepEqual(
      [...rows],
      [
        {
          id: "bpr_1",
          specHash: await bountySpecHash("Fix login", "Steps"),
          specHashVersion: 2,
        },
        // Stale before, and left so: version 1 reads as stale.
        {
          id: "bpr_2",
          specHash: hashV1("Edited since", "Said less", "Task"),
          specHashVersion: 1,
        },
        // Normalized in SQL exactly as the application normalizes it.
        {
          id: "bpr_3",
          specHash: await bountySpecHash(awkward.title, awkward.description),
          specHashVersion: 2,
        },
      ],
    );
  });

  test("a spec revision moves only when drafted from the bounty as it is", async () => {
    const rows = await sql<
      { id: string; specHash: string; specHashVersion: number }[]
    >`
      select id, spec_hash as "specHash", spec_hash_version as "specHashVersion"
      from bounty_spec order by id
    `;
    assert.deepEqual(
      [...rows],
      [
        {
          id: "bsp_1",
          specHash: hashV1("Fix login", "Older steps", "Bug"),
          specHashVersion: 1,
        },
        {
          id: "bsp_2",
          specHash: await bountySpecHash("Fix login", "Steps"),
          specHashVersion: 2,
        },
      ],
    );
  });

  test("the columns are gone, and the bounties and profiles kept", async () => {
    const columns = await sql<{ table: string; column: string }[]>`
      select table_name as "table", column_name as "column"
      from information_schema.columns
      where (table_name = 'bounty' and column_name in ('issue_type', 'priority', 'labels'))
        or (table_name = 'bounty_profile' and column_name = 'bounty')
    `;
    assert.deepEqual([...columns], []);
    const [counted] = await sql<{ bounties: number; profiles: number }[]>`
      select
        (select count(*)::int from bounty) as bounties,
        (select count(*)::int from bounty_profile) as profiles
    `;
    assert.deepEqual(counted, { bounties: 3, profiles: 1 });
    const [{ name } = { name: null }] = await sql<{ name: string | null }[]>`
      select to_regclass('bounty_spec_hash')::text as name
    `;
    assert.equal(name, null);
  });
});

describe("migration 0050: a proposal's version", () => {
  let sql: postgres.Sql;
  let folder: string | undefined;
  const decided = new Date(Date.UTC(2026, 8, 1, 12));

  before(async () => {
    await recreate(VERSION_SCRATCH_DB);
    folder = await migrationsBefore(50);
    await runMigrations({
      url: scratchUrl(VERSION_SCRATCH_DB),
      migrationsFolder: folder,
    });
    sql = postgres(scratchUrl(VERSION_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
    await sql`insert into organization (id, name, slug) values ('org_a', 'A', 'org-a')`;
    const rateCard = sql.json({
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    });
    for (const [n, status, revision] of [
      [1, "approved", 3],
      [2, "proposed", 4],
    ] as const) {
      await sql`insert into bounty (id, organization_id, title) values (${`bty_${n}`}, 'org_a', 'Fix login')`;
      await sql`
        insert into bounty_run (
          id, organization_id, request_id, selection, rate_card,
          requested_model, prompt_version, kind, bounty_id, status
        ) values (
          ${`run_${n}`}, 'org_a', ${`request-${n}`}, '{}', ${rateCard},
          'model', 'v1', 'bounty', ${`bty_${n}`}, 'succeeded'
        )
      `;
      await sql`
        insert into bounty_proposal (
          id, organization_id, run_id, bounty_id, spec_hash, rate_card,
          model_complexity, model_confidence, model_rationale, actual_model,
          prompt_version, complexity, amount_minor, currency, status,
          revision, decided_at
        ) values (
          ${`bpr_${n}`}, 'org_a', ${`run_${n}`}, ${`bty_${n}`}, ${"a".repeat(64)},
          ${rateCard}, 'M', 'high', 'A few files.', 'model', 'v1', 'M', 200,
          'USD', ${status}, ${revision},
          ${status === "approved" ? decided : null}
        )
      `;
    }
    await sql.end();

    await runMigrations({
      url: scratchUrl(VERSION_SCRATCH_DB),
      migrationsFolder: "drizzle",
    });
    sql = postgres(scratchUrl(VERSION_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
  });

  after(async () => {
    await sql?.end();
    if (folder !== undefined)
      await rm(folder, { recursive: true, force: true });
    await drop(VERSION_SCRATCH_DB);
  });

  test("an approved proposal is version 1 from its decision; a proposed one has none", async () => {
    const rows = await sql`
      select id, version, versioned_at, version_revision
      from bounty_proposal order by id
    `;
    assert.deepEqual(
      rows.map((row) => ({
        id: row["id"],
        version: row["version"],
        versionedAt:
          (row["versioned_at"] as Date | null)?.toISOString() ?? null,
        versionRevision: row["version_revision"],
      })),
      [
        {
          id: "bpr_1",
          version: 1,
          versionedAt: decided.toISOString(),
          versionRevision: 3,
        },
        { id: "bpr_2", version: 0, versionedAt: null, versionRevision: null },
      ],
    );
    // And an approved proposal is held to being a version.
    await assert.rejects(
      sql`update bounty_proposal set status = 'approved' where id = 'bpr_2'`,
    );
  });
});

describe("migration 0059: a proposal's repositories", () => {
  let sql: postgres.Sql;
  let folder: string | undefined;

  before(async () => {
    await recreate(REPOSITORIES_SCRATCH_DB);
    folder = await migrationsBefore(59);
    await runMigrations({
      url: scratchUrl(REPOSITORIES_SCRATCH_DB),
      migrationsFolder: folder,
    });
    sql = postgres(scratchUrl(REPOSITORIES_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
    await sql`insert into organization (id, name, slug) values ('org_a', 'A', 'org-a')`;
    await sql`insert into github_connection (id, organization_id, installation_id, account_login, account_type, repository_selection, permissions) values ('ghc_a', 'org_a', '1', 'example', 'Organization', 'all', '{}')`;
    await sql`insert into github_repo (id, organization_id, connection_id, role, external_id, full_name, default_branch) values ('ghr_a', 'org_a', 'ghc_a', 'source', '11', 'example/api', 'main')`;
    await sql`insert into repo_snapshot (id, repo_id, commit_sha, ref, tree_sha, tree_key, file_count, total_bytes, languages, facts) values ('rsn_a', 'ghr_a', 'abc', 'refs/heads/main', 'tree', 'tree-key', 1, 1, '{}', '{}')`;
    await sql`insert into jira_connection (id, organization_id, cloud_id, site_url, site_name) values ('jrc_a', 'org_a', 'cloud', 'https://acme.example', 'Acme')`;
    await sql`insert into jira_board (id, organization_id, connection_id, external_id, name, board_type, source_repo_id) values ('jrb_a', 'org_a', 'jrc_a', '1', 'Board', 'scrum', 'ghr_a')`;
    const rateCard = sql.json({
      currency: "USD",
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    });
    // One drafted beside a snapshot, one beside none.
    for (const [n, snapshotId] of [
      [1, "rsn_a"],
      [2, null],
    ] as const) {
      await sql`insert into bounty (id, organization_id, title, repo_id) values (${`bty_${n}`}, 'org_a', 'Fix login', 'ghr_a')`;
      await sql`
        insert into bounty_run (
          id, organization_id, request_id, selection, rate_card,
          requested_model, prompt_version, kind, bounty_id, status
        ) values (
          ${`run_${n}`}, 'org_a', ${`request-${n}`}, '{}', ${rateCard},
          'model', 'v1', 'bounty', ${`bty_${n}`}, 'succeeded'
        )
      `;
      await sql`
        insert into bounty_proposal (
          id, organization_id, run_id, bounty_id, spec_hash, rate_card,
          model_complexity, model_confidence, model_rationale, actual_model,
          prompt_version, complexity, amount_minor, currency, repo_snapshot_id
        ) values (
          ${`bpr_${n}`}, 'org_a', ${`run_${n}`}, ${`bty_${n}`}, ${"a".repeat(64)},
          ${rateCard}, 'M', 'high', 'A few files.', 'model', 'v1', 'M', 200,
          'USD', ${snapshotId}
        )
      `;
    }
    await sql`insert into bounty_profile (id, organization_id, proposal_id, spec_revision, spec_hash, snapshot_id) values ('bpf_1', 'org_a', 'bpr_1', 1, ${"a".repeat(64)}, 'rsn_a')`;
    await sql.end();

    await runMigrations({
      url: scratchUrl(REPOSITORIES_SCRATCH_DB),
      migrationsFolder: "drizzle",
    });
    sql = postgres(scratchUrl(REPOSITORIES_SCRATCH_DB), {
      max: 1,
      onnotice: () => {},
    });
  });

  after(async () => {
    await sql?.end();
    if (folder !== undefined)
      await rm(folder, { recursive: true, force: true });
    await drop(REPOSITORIES_SCRATCH_DB);
  });

  test("the snapshot a proposal was drafted beside is the one repository it touches", async () => {
    const rows = await sql`
      select id, repositories from bounty_proposal order by id
    `;
    assert.deepEqual(
      rows.map((row) => [row["id"], row["repositories"]]),
      [
        ["bpr_1", [{ repoId: "ghr_a", snapshotId: "rsn_a" }]],
        ["bpr_2", []],
      ],
    );
  });

  test("the columns are gone, and a revision is profiled once per snapshot", async () => {
    const columns = await sql`
      select table_name, column_name from information_schema.columns
      where (table_name, column_name) in (
        ('bounty', 'repo_id'),
        ('bounty_proposal', 'repo_snapshot_id'),
        ('jira_board', 'source_repo_id')
      )
    `;
    assert.deepEqual([...columns], []);
    // The profile made before is kept.
    const [kept] =
      await sql`select snapshot_id from bounty_profile where id = 'bpf_1'`;
    assert.equal(kept?.["snapshot_id"], "rsn_a");
    // A second snapshot of the same revision is a profile of its own...
    await sql`insert into repo_snapshot (id, repo_id, commit_sha, ref, tree_sha, tree_key, file_count, total_bytes, languages, facts) values ('rsn_b', 'ghr_a', 'def', 'refs/heads/main', 'tree', 'tree-key-b', 1, 1, '{}', '{}')`;
    await sql`insert into bounty_profile (id, organization_id, proposal_id, spec_revision, spec_hash, snapshot_id) values ('bpf_2', 'org_a', 'bpr_1', 1, ${"a".repeat(64)}, 'rsn_b')`;
    // ...and the same snapshot twice is not.
    await assert.rejects(
      sql`insert into bounty_profile (id, organization_id, proposal_id, spec_revision, spec_hash, snapshot_id) values ('bpf_3', 'org_a', 'bpr_1', 1, ${"a".repeat(64)}, 'rsn_a')`,
    );
  });
});
