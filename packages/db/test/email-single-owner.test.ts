/**
 * The single-owner triggers, against a real Postgres.
 *
 * Every other email test runs on `fake-email-db.ts`, which is the right tool
 * for `createEmailStore`'s branching but cannot execute a trigger: migrations
 * 0007-0009 are SQL, and a fake that never runs them proves nothing about
 * them. That gap is the reason this file exists. The rule they enforce —
 * one address, one account, across both `user.email` and `user_email.email` —
 * is enforced *only* here, because no constraint can span two tables.
 *
 * What is tested is the deployed artefact, not a copy: `runMigrations` applies
 * the same `drizzle/` directory the API runs at boot, so a trigger that is
 * malformed, or a migration missing from `_journal.json`, fails here.
 *
 * Skips when no database is reachable rather than failing. The suite has to
 * stay runnable on a laptop with nothing started, and a test that cannot tell
 * "the triggers are broken" from "Postgres is not running" is worse than no
 * test. CI supplies `DATABASE_URL` via a service container, so the skip is a
 * local convenience and never a silent pass there.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { runMigrations } from "../src/migrate.js";

/**
 * Where to find a server, and which database to build on it.
 *
 * The scratch database is created and dropped by this file rather than reusing
 * the application's: these tests write deliberately conflicting rows, and the
 * cleanest way to guarantee they cannot damage development data is to never
 * open a connection to it. The name is fixed rather than random so a crashed
 * run leaves one database to drop, not a growing pile.
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
 * Whether a server answered at all.
 *
 * Distinguished from every other failure on purpose. A refused connection
 * means "nothing is running here", which is the one case worth skipping for;
 * a server that answers and then errors is a real failure and must surface.
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
        // Dropped first so a crashed previous run cannot leave rows that make
        // these tests pass or fail for the wrong reason.
        await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
        await admin.unsafe(`create database ${SCRATCH_DB}`);
      } finally {
        await admin.end();
      }

      // The real migration path, including the journal. A migration present on
      // disk but absent from `_journal.json` never runs here either, which is
      // exactly the failure worth catching.
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

    /**
     * Users are inserted directly rather than through Better Auth: the point
     * is to test the database's own guarantee against *any* writer, and a
     * helper that went through the application would be testing the
     * application's guard instead — the one that already has coverage.
     */
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
      // The exact split state 0007 exists to forbid, approached from the
      // `user` side: B has proved the address, A tries to carry it.
      await addUser("u_primary_a", "a@example.test");
      await addUser("u_primary_b", "b@example.test");
      await addProvenEmail("e_primary", "u_primary_b", "shared@example.test");

      const message = await refusal(sql`
        update "user" set email = 'shared@example.test' where id = 'u_primary_a'
      `);

      assert.match(String(message), /already held by user/);
    });

    test("a primary address cannot be proven by another user", async () => {
      // The same rule from the `user_email` side. Both directions matter:
      // 0007 installs two triggers precisely because one table cannot see the
      // other, and a single trigger would leave this half open.
      await addUser("u_proven_a", "proven-a@example.test");
      await addUser("u_proven_b", "proven-b@example.test");

      const message = await refusal(
        addProvenEmail("e_proven", "u_proven_b", "proven-a@example.test"),
      );

      assert.match(String(message), /already held by user/);
    });

    test("a user may hold their own address in both tables", async () => {
      // The guard must not fire on the ordinary case. Every sign-in writes
      // both rows for one person, so a trigger that refused this would break
      // sign-in outright rather than subtly.
      await addUser("u_self", "self@example.test");

      const message = await refusal(
        addProvenEmail("e_self", "u_self", "self@example.test"),
      );

      assert.equal(message, undefined);
    });

    test("reassigning a proven address to another user is refused", async () => {
      // Gap 1 from 0008. Under 0007 the trigger fired on `UPDATE OF email`
      // only, so moving the row to a different user changed the owner without
      // firing it at all — landing in the forbidden state by a path the
      // trigger did not watch.
      await addUser("u_move_a", "move-a@example.test");
      await addUser("u_move_b", "move-b@example.test");
      await addProvenEmail("e_move", "u_move_a", "move-a@example.test");

      const message = await refusal(sql`
        update user_email set user_id = 'u_move_b' where id = 'e_move'
      `);

      assert.match(String(message), /already held by user/);
    });

    test("the cross-table check ignores case", async () => {
      // Gap 2 from 0008. `=` let `alice@` and `ALICE@` both be held. The
      // application lowercases on the way in, which is why the database must
      // not assume it did — this writes the mixed case the application would
      // never produce, because a backstop is for the writers that bypass it.
      await addUser("u_case_a", "case-a@example.test");
      await addUser("u_case_b", "mixed@example.test");

      const message = await refusal(
        addProvenEmail("e_case_upper", "u_case_a", "MIXED@Example.TEST"),
      );

      assert.match(String(message), /already held by user/);
    });

    test("two users cannot prove one address differing only in case", async () => {
      // The half 0008 left open, and the reason 0011 exists. The trigger only
      // ever compares against the *other* table, so two `user_email` rows were
      // left to the column's own constraint — which was byte-exact. These two
      // inserts both succeeded with 0007-0009 installed and firing.
      await addUser("u_same_a", "same-a@example.test");
      await addUser("u_same_b", "same-b@example.test");
      await addProvenEmail("e_same", "u_same_a", "dup@example.test");

      const message = await refusal(
        addProvenEmail("e_same_upper", "u_same_b", "DUP@Example.TEST"),
      );

      assert.match(String(message), /user_email_email_lower_unique/);
    });

    test("two accounts cannot exist on one address differing only in case", async () => {
      // The same hole on `user`, where it is worse: two separate accounts on
      // one address, each able to sign in.
      await addUser("u_acct", "acct@example.test");

      const message = await refusal(
        addUser("u_acct_upper", "ACCT@Example.TEST"),
      );

      assert.match(String(message), /user_email_lower_unique/);
    });

    test("concurrent claims on one address cannot both commit", async () => {
      // The race 0009 closes, reproduced as it actually occurred: two
      // transactions, one writing each table, overlapping. Under READ
      // COMMITTED without the advisory lock both SELECTs see nothing and both
      // commit. The assertion is deliberately on the *outcome* — exactly one
      // survives — rather than on which one fails, because either order is
      // correct and pinning one would make this flaky by design.
      await addUser("u_race_a", "race-a@example.test");
      await addUser("u_race_b", "race-b@example.test");

      const contested = "contested@example.test";

      const viaUser = sql
        .begin(async (tx) => {
          await tx`update "user" set email = ${contested} where id = 'u_race_a'`;
          // Hold the transaction open past the other's check, so both are
          // in flight at once. Without this they serialize by luck and the
          // test passes even with the lock removed.
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

      // And the surviving state is single-owner, which is the property that
      // actually matters — "one failed" would also be satisfied by both
      // failing.
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
