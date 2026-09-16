import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { authSchema } from "../src/auth-schema.js";

/**
 * These assertions look like they are testing Drizzle, but they are testing
 * the two naming rules Better Auth's adapter depends on. Both fail at runtime
 * rather than at compile time — the adapter looks tables and columns up by
 * string — so a rename would otherwise surface as a failed sign-in against a
 * real database, which is exactly the thing no test here is allowed to need.
 */

test("authSchema is keyed by Better Auth's singular model names", () => {
  // The adapter resolves a model as `schema[modelName]`, and those names are
  // singular unless `usePlural` is set. `users` would not be found.
  assert.deepEqual(Object.keys(authSchema).sort(), [
    "account",
    "session",
    "user",
    "verification",
  ]);
});

test("authSchema excludes the todos table", () => {
  // The adapter treats every key it is given as a model it may own. `todos`
  // is ours and has no business in that namespace.
  assert.equal("todos" in authSchema, false);
});

test("auth table properties are camelCase, and map to snake_case columns", () => {
  // The distinction the adapter cares about: it indexes the table object by
  // *property* name, while the column name is only ever seen by Postgres.
  const { columns } = getTableConfig(authSchema.session);
  const byProperty = new Map(columns.map((c) => [c.name, c]));

  assert.equal(authSchema.session.userId.name, "user_id");
  assert.equal(byProperty.has("user_id"), true);
});

test("every auth table has a text primary key", () => {
  // Better Auth generates its own string ids; a serial or uuid column would
  // reject them at insert time.
  for (const [model, table] of Object.entries(authSchema)) {
    const primary = getTableConfig(table).columns.filter((c) => c.primary);
    assert.equal(primary.length, 1, `${model} should have one primary key`);
    assert.equal(
      primary[0]?.getSQLType(),
      "text",
      `${model}'s primary key should be text`,
    );
  }
});

test("sessions and accounts cascade when their user is deleted", () => {
  // Without this a deleted user's sessions stay valid rows, which is a live
  // session for an account that no longer exists.
  for (const table of [authSchema.session, authSchema.account]) {
    const [reference] = getTableConfig(table).foreignKeys;
    assert.equal(reference?.onDelete, "cascade");
  }
});

test("the session token is unique", () => {
  // The token is the lookup key on every authenticated request; a duplicate
  // would make "which session is this" ambiguous.
  const token = getTableConfig(authSchema.session).columns.find(
    (c) => c.name === "token",
  );
  assert.equal(token?.isUnique, true);
});

test("one provider identity can belong to only one user", () => {
  // Better Auth refuses to link an account another user holds, on all three
  // paths — but it *assumes* the invariant rather than tolerating a breach:
  // `findAccountByKey` throws when two rows collide, breaking sign-in for both
  // users at once. A bad migration or manual insert could otherwise create
  // that state silently.
  const { uniqueConstraints } = getTableConfig(authSchema.account);
  const identity = uniqueConstraints.find(
    (constraint) => constraint.name === "account_provider_identity_unique",
  );

  assert.notEqual(identity, undefined, "expected the identity constraint");
  assert.deepEqual(identity?.columns.map((column) => column.name).sort(), [
    "account_id",
    "provider_id",
  ]);
});
