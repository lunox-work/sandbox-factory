/**
 * The shared handle namespace (migrations 0029-0030), against a real
 * Postgres; the fakes cannot execute SQL or fire triggers. `runMigrations`
 * applies the same `drizzle/` directory a deploy does.
 *
 * Two scratch databases: one migrated to the head, for the rules; one migrated
 * to 0028, seeded with the conflicts the old rules let in, and then migrated
 * on, for the backfill.
 *
 * Skips when no server is reachable, so the suite runs on a bare laptop. CI
 * supplies `DATABASE_URL` via a service container, so it never skips there.
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
/** Fixed names, so a crashed run leaves two databases to drop, not a pile. */
const RULES_DB = "sandbox_factory_handle_test";
const BACKFILL_DB = "sandbox_factory_handle_backfill_test";

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function serverReachable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
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

/** The error a write raised, or undefined if it was allowed. */
async function refusal(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Inserted directly, not through Better Auth or the stores: this tests the
// database's guarantee against any writer, not the application's guard.
async function addUser(
  sql: postgres.Sql,
  id: string,
  username: string,
): Promise<void> {
  await sql`
    insert into "user" (id, name, email, username, display_username)
    values (${id}, ${id}, ${`${id}@example.test`}, ${username}, ${username})
  `;
}

async function addTeam(
  sql: postgres.Sql,
  id: string,
  slug: string,
): Promise<void> {
  await sql`
    insert into organization (id, name, slug, kind)
    values (${id}, ${id}, ${slug}, 'team')
  `;
}

async function addPersonal(
  sql: postgres.Sql,
  id: string,
  userId: string,
  slug: string,
): Promise<void> {
  await sql`
    insert into organization (id, name, slug, kind, personal_user_id)
    values (${id}, ${id}, ${slug}, 'personal', ${userId})
  `;
}

async function slugOf(sql: postgres.Sql, id: string): Promise<string> {
  const [row] = await sql<{ slug: string }[]>`
    select slug from organization where id = ${id}
  `;
  assert.ok(row, `no organization ${id}`);
  return row.slug;
}

async function holderOf(
  sql: postgres.Sql,
  handle: string,
): Promise<string | null | undefined> {
  const [row] = await sql<
    { user_id: string | null; organization_id: string | null }[]
  >`select user_id, organization_id from handle where handle = ${handle}`;
  return row === undefined ? undefined : (row.user_id ?? row.organization_id);
}

const reachable = await serverReachable();
const skip = reachable ? false : `no Postgres at ${ADMIN_URL}`;

describe("one handle namespace", { skip }, () => {
  let sql: postgres.Sql;

  before(async () => {
    await recreate(RULES_DB);
    await runMigrations({ url: urlFor(RULES_DB), migrationsFolder: "drizzle" });
    sql = postgres(urlFor(RULES_DB), { max: 4, onnotice: () => {} });
  });

  after(async () => {
    await sql?.end();
    await drop(RULES_DB);
  });

  test("a team cannot take a username", async () => {
    await addUser(sql, "u_team_after", "taken-by-user");

    const message = await refusal(
      addTeam(sql, "o_team_after", "taken-by-user"),
    );

    assert.match(String(message), /already taken|duplicate key/);
  });

  test("a user cannot rename onto a team's handle", async () => {
    // The direction the old checks missed: a username change looked only at
    // other usernames.
    await addTeam(sql, "o_user_after", "taken-by-team");
    await addUser(sql, "u_user_after", "user-after");

    const message = await refusal(sql`
      update "user" set username = 'taken-by-team' where id = 'u_user_after'
    `);

    assert.match(String(message), /handle taken-by-team is already taken/);
  });

  test("a new user cannot sign up onto a team's handle", async () => {
    await addTeam(sql, "o_signup", "signup-team");

    const message = await refusal(addUser(sql, "u_signup", "signup-team"));

    assert.match(String(message), /already taken/);
  });

  test("case does not make a second handle", async () => {
    await addUser(sql, "u_case", "mixed-case");

    const message = await refusal(addTeam(sql, "o_case", "Mixed-Case"));

    assert.match(String(message), /already taken/);
  });

  test("a team cannot rename onto another team's handle", async () => {
    await addTeam(sql, "o_rename_a", "rename-a");
    await addTeam(sql, "o_rename_b", "rename-b");

    const message = await refusal(sql`
      update organization set slug = 'rename-a' where id = 'o_rename_b'
    `);

    assert.match(String(message), /already taken|duplicate key/);
  });

  test("a renamed user releases the old handle and takes the personal organization along", async () => {
    await addUser(sql, "u_moving", "moving-before");
    await addPersonal(sql, "o_moving", "u_moving", "moving-before");

    await sql`update "user" set username = 'moving-after' where id = 'u_moving'`;

    assert.equal(await slugOf(sql, "o_moving"), "moving-after");
    assert.equal(await holderOf(sql, "moving-after"), "u_moving");
    // Released, not squatted: a team can have it now.
    assert.equal(await holderOf(sql, "moving-before"), undefined);
    await addTeam(sql, "o_moving_team", "moving-before");
    assert.equal(await holderOf(sql, "moving-before"), "o_moving_team");
  });

  test("a personal organization cannot carry anything but its owner's username", async () => {
    await addUser(sql, "u_personal", "personal-owner");

    const atCreate = await refusal(
      addPersonal(sql, "o_personal", "u_personal", "something-else"),
    );
    assert.match(String(atCreate), /must carry its owner's username/);

    await addPersonal(sql, "o_personal", "u_personal", "personal-owner");
    const atRename = await refusal(sql`
      update organization set slug = 'something-else' where id = 'o_personal'
    `);
    assert.match(String(atRename), /must carry its owner's username/);
  });

  test("a personal organization claims no handle of its own", async () => {
    await addUser(sql, "u_no_claim", "no-claim");
    await addPersonal(sql, "o_no_claim", "u_no_claim", "no-claim");

    // The one row is the user's; the organization rides on it.
    assert.equal(await holderOf(sql, "no-claim"), "u_no_claim");
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from handle where organization_id = 'o_no_claim'
    `;
    assert.equal(row?.count, 0);
  });

  test("deleting a holder releases its handle", async () => {
    await addTeam(sql, "o_deleted", "deleted-team");
    await addUser(sql, "u_deleted", "deleted-user");

    await sql`delete from organization where id = 'o_deleted'`;
    await sql`delete from "user" where id = 'u_deleted'`;

    assert.equal(await holderOf(sql, "deleted-team"), undefined);
    assert.equal(await holderOf(sql, "deleted-user"), undefined);
  });

  test("two writers claiming one handle at once cannot both win", async () => {
    // The race 0009 had to close for email with an advisory lock. Here the
    // primary key does it: the second insert waits on the first's
    // uncommitted key, then fails when it commits.
    await addUser(sql, "u_race", "race-user");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = sql.begin(async (tx) => {
      await tx`update "user" set username = 'contested' where id = 'u_race'`;
      await held;
    });
    // Give the first transaction time to take its row lock on the key.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = refusal(addTeam(sql, "o_race", "contested"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await first;

    assert.match(String(await second), /already taken|duplicate key/);
    assert.equal(await holderOf(sql, "contested"), "u_race");
  });
});

describe("backfill of conflicts the old rules let in", { skip }, () => {
  let sql: postgres.Sql;
  let before0029: string;

  before(async () => {
    // A copy of `drizzle/` whose journal stops at 0028, so the seed below is
    // written into the schema as it was, conflicts and all.
    before0029 = await mkdtemp(join(tmpdir(), "handle-backfill-"));
    await cp("drizzle", before0029, { recursive: true });
    const journalPath = join(before0029, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 28);
    await writeFile(journalPath, JSON.stringify(journal));

    await recreate(BACKFILL_DB);
    await runMigrations({
      url: urlFor(BACKFILL_DB),
      migrationsFolder: before0029,
    });
    sql = postgres(urlFor(BACKFILL_DB), { max: 2, onnotice: () => {} });

    // A person and a team on one handle, which a username change allowed.
    await addUser(sql, "u_shared", "shared");
    await addPersonal(sql, "o_shared_personal", "u_shared", "shared-p");
    await addTeam(sql, "o_shared_team", "shared");
    // The suffix that team would get first is already a later team's.
    await addTeam(sql, "o_suffix_taken", "shared-2");
    // Two personal organizations each carrying the other owner's username:
    // handles edited independently of usernames could reach this. Moving
    // either first would collide with the other.
    await addUser(sql, "u_drifted", "drifted-now");
    await addUser(sql, "u_holder", "drifted-before");
    await addPersonal(sql, "o_drifted", "u_drifted", "drifted-before");
    await addPersonal(sql, "o_holder", "u_holder", "drifted-now");
    // A long handle, whose suffix has to fit inside 30 characters.
    await addUser(sql, "u_long", "a-handle-that-is-thirty-chars1");
    await addTeam(sql, "o_long", "a-handle-that-is-thirty-chars1");

    await runMigrations({
      url: urlFor(BACKFILL_DB),
      migrationsFolder: "drizzle",
    });
  });

  after(async () => {
    await sql?.end();
    await drop(BACKFILL_DB);
    if (before0029 !== undefined) {
      await rm(before0029, { recursive: true, force: true });
    }
  });

  test("a user keeps their username and the team moves to a free suffix", async () => {
    assert.equal(await holderOf(sql, "shared"), "u_shared");
    // Not -2, which a later team already had and keeps.
    assert.equal(await slugOf(sql, "o_shared_team"), "shared-3");
    assert.equal(await holderOf(sql, "shared-3"), "o_shared_team");
    assert.equal(await slugOf(sql, "o_suffix_taken"), "shared-2");
  });

  test("a personal organization is moved onto its owner's username", async () => {
    assert.equal(await slugOf(sql, "o_shared_personal"), "shared");
    // Swapped handles settle without either blocking the other.
    assert.equal(await slugOf(sql, "o_drifted"), "drifted-now");
    assert.equal(await slugOf(sql, "o_holder"), "drifted-before");
  });

  test("a suffix is kept inside the handle length limit", async () => {
    const slug = await slugOf(sql, "o_long");
    assert.equal(slug, "a-handle-that-is-thirty-char-2");
    assert.ok(slug.length <= 30);
  });

  test("every user and every team holds exactly one row", async () => {
    const [users] = await sql<{ missing: number }[]>`
      select count(*)::int as missing from "user" u
       where not exists (select 1 from handle h where h.user_id = u.id)
    `;
    const [teams] = await sql<{ missing: number }[]>`
      select count(*)::int as missing from organization o
       where o.kind = 'team'
         and not exists (select 1 from handle h where h.organization_id = o.id)
    `;
    assert.equal(users?.missing, 0);
    assert.equal(teams?.missing, 0);
  });

  test("the triggers are live after the backfill", async () => {
    const message = await refusal(sql`
      update organization set slug = 'shared' where id = 'o_suffix_taken'
    `);
    assert.match(String(message), /already taken|duplicate key/);
  });
});
