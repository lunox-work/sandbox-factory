/**
 * The schema was one file until the Jira and commercials tables were about to
 * be added to it. These tests pin the two properties the split could break,
 * both of which fail at runtime rather than compile time:
 *
 * - The barrel still re-exports every table. `drizzle.config.ts` and
 *   `drizzleAdapter` read `schema.ts`, so a table declared in a module but
 *   left out of the barrel is invisible to migrations and to Better Auth.
 * - `auth.ts` and `organizations.ts` import each other, and the tables they
 *   point at across that cycle still resolve.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import * as schema from "../src/schema.js";
import * as authSchema from "../src/schema/auth.js";
import * as organizationSchema from "../src/schema/organizations.js";
import * as todoSchema from "../src/schema/todos.js";

/** The table name Postgres knows, which is what a foreign key resolves to. */
function tableName(table: PgTable): string {
  return getTableConfig(table).name;
}

test("the barrel re-exports every table each module declares", () => {
  // Not a hand-written list: a new table in a module is picked up here, so
  // this keeps holding as the schema grows rather than going stale.
  for (const module of [authSchema, organizationSchema, todoSchema]) {
    for (const [name, value] of Object.entries(module)) {
      assert.equal(
        (schema as Record<string, unknown>)[name],
        value,
        `schema.ts does not re-export ${name}`,
      );
    }
  }
});

test("every table in the barrel is a distinct Postgres table", () => {
  // Typed as `unknown` first: the exports are a union of specifically-typed
  // tables, which does not narrow to the generic `PgTable` a predicate needs.
  const names = (Object.values(schema) as unknown[])
    .flatMap((value) => {
      // Types erase, so the exports are filtered by shape at runtime.
      try {
        return typeof value === "object" && value !== null
          ? [tableName(value as PgTable)]
          : [];
      } catch {
        return [];
      }
    })
    .filter((name) => name !== "");

  assert.ok(
    names.length >= 8,
    `expected the eight tables, saw ${names.length}`,
  );
  // A copy-paste that reused a table name would otherwise surface as a
  // confusing migration diff.
  assert.equal(new Set(names).size, names.length);
});

test("foreign keys across the auth/organization cycle resolve", () => {
  // The cycle is real: `session` points at `organization`, `member` points
  // back at `user`. Drizzle's `() => table.column` thunks are what make it
  // safe, and a non-thunk reference would leave these undefined at import.
  const sessionToOrganization = getTableConfig(authSchema.session)
    .foreignKeys.map((key) => key.reference())
    .find(
      (reference) => reference.foreignTable === organizationSchema.organization,
    );
  assert.ok(sessionToOrganization, "session does not reference organization");

  const memberToUser = getTableConfig(organizationSchema.member)
    .foreignKeys.map((key) => key.reference())
    .find((reference) => reference.foreignTable === authSchema.user);
  assert.ok(memberToUser, "member does not reference user");

  const todoToUser = getTableConfig(todoSchema.todos)
    .foreignKeys.map((key) => key.reference())
    .find((reference) => reference.foreignTable === authSchema.user);
  assert.ok(todoToUser, "todos does not reference user");
});
