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
  // The last three belong to the organization plugin, which resolves its
  // models the same way.
  assert.deepEqual(Object.keys(authSchema).sort(), [
    "account",
    "invitation",
    "member",
    "organization",
    "session",
    "user",
    "verification",
  ]);
});

test("authSchema excludes this product's own tables", () => {
  // The adapter treats every key it is given as a model it may own.
  assert.equal("jiraConnection" in authSchema, false);
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
    const userReference = getTableConfig(table).foreignKeys.find(
      (key) => key.reference().foreignTable === authSchema.user,
    );
    assert.equal(userReference?.onDelete, "cascade");
  }
});

test("memberships and invitations cascade with their organization", () => {
  // A deleted organization must not leave rows naming an id that is gone;
  // the plugin deletes them itself, and this is the second layer.
  for (const table of [authSchema.member, authSchema.invitation]) {
    const reference = getTableConfig(table).foreignKeys.find(
      (key) => key.reference().foreignTable === authSchema.organization,
    );
    assert.equal(reference?.onDelete, "cascade");
  }
});

test("a session survives the organization it was pointing at", () => {
  // `activeOrganizationId` is a preference. Cascading would sign people out
  // of the whole product because one of their organizations was deleted.
  const reference = getTableConfig(authSchema.session).foreignKeys.find(
    (key) => key.reference().foreignTable === authSchema.organization,
  );
  assert.equal(reference?.onDelete, "set null");
});

test("one person holds at most one membership per organization", () => {
  // The plugin checks before inserting but then assumes the invariant: a
  // duplicate shows up as a member who cannot be removed.
  const { uniqueConstraints } = getTableConfig(authSchema.member);
  const membership = uniqueConstraints.find(
    (constraint) => constraint.name === "member_organization_user_unique",
  );

  assert.notEqual(membership, undefined, "expected the membership constraint");
  assert.deepEqual(membership?.columns.map((column) => column.name).sort(), [
    "organization_id",
    "user_id",
  ]);
});

test("an organization handle is unique", () => {
  // Two organizations on one handle would make `/o/{slug}` ambiguous.
  const slug = getTableConfig(authSchema.organization).columns.find(
    (column) => column.name === "slug",
  );
  assert.equal(slug?.isUnique, true);
  assert.equal(slug?.notNull, true);
});

test("an organization's two names are both text and independently shaped", () => {
  // `id` is permanent and `slug` is renameable; conflating them is the bug
  // this pins against.
  const columns = getTableConfig(authSchema.organization).columns;
  const id = columns.find((column) => column.name === "id");
  const slug = columns.find((column) => column.name === "slug");

  assert.equal(id?.primary, true);
  // The handle is unique but is not the key: a rename must not rewrite every
  // row that references the organization.
  assert.notEqual(slug?.primary, true);
  assert.equal(slug?.isUnique, true);
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
