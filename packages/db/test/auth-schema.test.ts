import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { authSchema } from "../src/auth-schema.js";

/**
 * Pins the naming rules Better Auth's adapter depends on (see `schema.ts`).
 * The adapter looks names up by string, so a rename would otherwise surface
 * only as a failed sign-in against a real database.
 */

test("authSchema is keyed by Better Auth's singular model names", () => {
  // The adapter resolves `schema[modelName]`; `users` would not be found.
  assert.deepEqual(Object.keys(authSchema).sort(), [
    "account",
    "session",
    "user",
    "verification",
  ]);
});

test("authSchema excludes the todos table", () => {
  // The adapter treats every key it is given as a model it may own.
  assert.equal("todos" in authSchema, false);
});

test("auth table properties are camelCase, and map to snake_case columns", () => {
  // The adapter indexes by property name; only Postgres sees the column name.
  const { columns } = getTableConfig(authSchema.session);
  const byProperty = new Map(columns.map((c) => [c.name, c]));

  assert.equal(authSchema.session.userId.name, "user_id");
  assert.equal(byProperty.has("user_id"), true);
});

test("every auth table has a text primary key", () => {
  // Better Auth generates string ids; a serial or uuid column rejects them.
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
  // Otherwise a deleted user's sessions stay live.
  for (const table of [authSchema.session, authSchema.account]) {
    const [reference] = getTableConfig(table).foreignKeys;
    assert.equal(reference?.onDelete, "cascade");
  }
});

test("the session token is unique", () => {
  // The token is the lookup key on every authenticated request.
  const token = getTableConfig(authSchema.session).columns.find(
    (c) => c.name === "token",
  );
  assert.equal(token?.isUnique, true);
});

test("one provider identity can belong to only one user", () => {
  // Better Auth assumes this invariant: `findAccountByKey` throws on a
  // collision, breaking sign-in for both users. See `account` in schema.ts.
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
