/**
 * The single-owner triggers and indexes (migrations 0007-0011), against a
 * real Postgres; the fakes cannot execute SQL. `runMigrations` applies the
 * same `drizzle/` directory a deploy does, so a malformed trigger or a
 * migration missing from `_journal.json` fails here.
 *
 * Skips when no server is reachable, so the suite runs on a bare laptop. CI
 * supplies `DATABASE_URL` via a service container, so it never skips there.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { runMigrations } from "../src/migrate.js";

/**
 * A scratch database, created and dropped here, so conflicting rows never
 * touch development data. The name is fixed so a crashed run leaves one
 * database to drop, not a pile.
 */
const ADMIN_URL =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const SCRATCH_DB = "sandbox_factory_trigger_test";

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

/**
 * Whether a server answered at all. Only "nothing is running" is worth
 * skipping for; a server that answers and then errors must surface.
 */
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

const reachable = await serverReachable();

describe(
  "email single-owner triggers",
  { skip: reachable ? false : `no Postgres at ${ADMIN_URL}` },
  () => {
    let sql: postgres.Sql;

    before(async () => {
      const admin = postgres(ADMIN_URL, { max: 1 });
      try {
        // Dropped first: a crashed run must not leave rows behind.
        await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
        await admin.unsafe(`create database ${SCRATCH_DB}`);
      } finally {
        await admin.end();
      }

      // The real migration path, journal included.
      await runMigrations({ url: scratchUrl(), migrationsFolder: "drizzle" });
      sql = postgres(scratchUrl(), { max: 4 });
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

    // Inserted directly, not through Better Auth: this tests the database's
    // guarantee against any writer, not the application's guard.
    async function addUser(id: string, email: string): Promise<void> {
      await sql`
        insert into "user" (id, name, email, username, display_username)
        values (${id}, ${id}, ${email}, ${id}, ${id})
      `;
    }

    async function addProvenEmail(
      id: string,
      userId: string,
      email: string,
    ): Promise<void> {
      await sql`
        insert into user_email (id, user_id, email, provider_id, is_primary)
        values (${id}, ${userId}, ${email}, 'google', false)
      `;
    }

    /** The error a trigger raises, or undefined if the write was allowed. */
    async function refusal(
      write: Promise<unknown>,
    ): Promise<string | undefined> {
      try {
        await write;
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    test("a proven address cannot be claimed as another user's primary", async () => {
      // 0007, from the `user` side: B proved the address, A tries to carry it.
      await addUser("u_primary_a", "a@example.test");
      await addUser("u_primary_b", "b@example.test");
      await addProvenEmail("e_primary", "u_primary_b", "shared@example.test");

      const message = await refusal(sql`
        update "user" set email = 'shared@example.test' where id = 'u_primary_a'
      `);

      assert.match(String(message), /already held by user/);
    });

    test("a primary address cannot be proven by another user", async () => {
      // 0007, from the `user_email` side; each table needs its own trigger.
      await addUser("u_proven_a", "proven-a@example.test");
      await addUser("u_proven_b", "proven-b@example.test");

      const message = await refusal(
        addProvenEmail("e_proven", "u_proven_b", "proven-a@example.test"),
      );

      assert.match(String(message), /already held by user/);
    });

    test("a user may hold their own address in both tables", async () => {
      // The ordinary case: every sign-in writes both rows for one person.
      await addUser("u_self", "self@example.test");

      const message = await refusal(
        addProvenEmail("e_self", "u_self", "self@example.test"),
      );

      assert.equal(message, undefined);
    });

    test("reassigning a proven address to another user is refused", async () => {
      // 0008, gap 1: the 0007 trigger fired on `UPDATE OF email` only, so
      // changing `user_id` moved the row without firing it.
      await addUser("u_move_a", "move-a@example.test");
      await addUser("u_move_b", "move-b@example.test");
      await addProvenEmail("e_move", "u_move_a", "move-a@example.test");

      const message = await refusal(sql`
        update user_email set user_id = 'u_move_b' where id = 'e_move'
      `);

      assert.match(String(message), /already held by user/);
    });

    test("the cross-table check ignores case", async () => {
      // 0008, gap 2: `=` was case-sensitive. The application lowercases, so
      // this writes the mixed case only a writer bypassing it would produce.
      await addUser("u_case_a", "case-a@example.test");
      await addUser("u_case_b", "mixed@example.test");

      const message = await refusal(
        addProvenEmail("e_case_upper", "u_case_a", "MIXED@Example.TEST"),
      );

      assert.match(String(message), /already held by user/);
    });

    test("two users cannot prove one address differing only in case", async () => {
      // 0011: the triggers only compare against the other table, and the
      // column's own constraint was byte-exact.
      await addUser("u_same_a", "same-a@example.test");
      await addUser("u_same_b", "same-b@example.test");
      await addProvenEmail("e_same", "u_same_a", "dup@example.test");

      const message = await refusal(
        addProvenEmail("e_same_upper", "u_same_b", "DUP@Example.TEST"),
      );

      assert.match(String(message), /user_email_email_lower_unique/);
    });

    test("two accounts cannot exist on one address differing only in case", async () => {
      // 0011 on `user`: otherwise two accounts on one address could sign in.
      await addUser("u_acct", "acct@example.test");

      const message = await refusal(
        addUser("u_acct_upper", "ACCT@Example.TEST"),
      );

      assert.match(String(message), /user_email_lower_unique/);
    });

    test("concurrent claims on one address cannot both commit", async () => {
      // 0009: two overlapping transactions, one writing each table. Without
      // the advisory lock both checks see nothing under READ COMMITTED and
      // both commit. Asserts that exactly one survives, not which: either
      // order is correct.
      await addUser("u_race_a", "race-a@example.test");
      await addUser("u_race_b", "race-b@example.test");

      const contested = "contested@example.test";

      const viaUser = sql
        .begin(async (tx) => {
          await tx`update "user" set email = ${contested} where id = 'u_race_a'`;
          // Hold the transaction open past the other's check. Without this
          // they serialize by luck and the test passes with the lock removed.
          await tx`select pg_sleep(0.3)`;
        })
        .then(
          () => true,
          () => false,
        );

      const viaProven = sql
        .begin(async (tx) => {
          await tx`select pg_sleep(0.1)`;
          await tx`
            insert into user_email (id, user_id, email, provider_id, is_primary)
            values ('e_race', 'u_race_b', ${contested}, 'github', false)
          `;
        })
        .then(
          () => true,
          () => false,
        );

      const [userWon, provenWon] = await Promise.all([viaUser, viaProven]);

      assert.equal(
        Number(userWon) + Number(provenWon),
        1,
        "exactly one of the two concurrent claims must survive",
      );

      // The property that matters: exactly one holder in the final state.
      const held = await sql<{ count: string }[]>`
        select count(*)::text as count from (
          select id as holder from "user" where lower(email) = ${contested}
          union all
          select user_id from user_email where lower(email) = ${contested}
        ) held
      `;
      assert.equal(held[0]?.count, "1");
    });
  },
);
