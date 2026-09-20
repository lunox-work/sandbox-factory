import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { invitation, member, todos, userEmail } from "../src/schema.js";

/**
 * Schema invariants nothing else in the build would catch: a missing index
 * degrades silently, and a nullable owner would let an unowned todo exist.
 */

test("todos.user_id is not nullable", () => {
  // A nullable owner would allow rows that belong to nobody.
  const { columns } = getTableConfig(todos);
  const userId = columns.find((column) => column.name === "user_id");
  assert.equal(userId?.notNull, true);
});

test("todos.user_id cascades on delete", () => {
  // A deleted account must not leave rows pointing at an id that is gone.
  const { foreignKeys } = getTableConfig(todos);
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0]?.onDelete, "cascade");
});

test("todos is indexed by owner and recency", () => {
  // Without it the list read is a sequential scan plus a sort.
  const { indexes } = getTableConfig(todos);
  const index = indexes.find(
    (candidate) => candidate.config.name === "todos_user_id_created_at_idx",
  );
  assert.notEqual(index, undefined);

  // Owner first: a composite index only serves the `where` when the filtered
  // column leads. `desc(created_at)` is an SQL expression with no `name`, so
  // only its presence is asserted.
  const columns = index?.config.columns ?? [];
  assert.equal(columns.length, 2);
  assert.equal(
    columns[0] !== undefined && "name" in columns[0]
      ? columns[0].name
      : undefined,
    "user_id",
  );
});

test("a user has at most one primary address", () => {
  // Two primaries would make `user.email` ambiguous about which it mirrors.
  const { indexes } = getTableConfig(userEmail);
  const primary = indexes.find(
    (candidate) => candidate.config.name === "user_email_one_primary",
  );
  assert.notEqual(primary, undefined);
  assert.equal(primary?.config.unique, true);
  assert.notEqual(primary?.config.where, undefined);
});

// ---- organizations --------------------------------------------------------

test("memberships are indexed by user", () => {
  // "Which organizations am I in" runs on every page load; without this it
  // is a sequential scan of every membership in the system.
  const { indexes } = getTableConfig(member);
  const index = indexes.find(
    (candidate) => candidate.config.name === "member_user_id_idx",
  );
  assert.notEqual(index, undefined);

  const columns = index?.config.columns ?? [];
  assert.equal(
    columns[0] !== undefined && "name" in columns[0]
      ? columns[0].name
      : undefined,
    "user_id",
  );
});

test("pending invitations are indexed by address and status", () => {
  // The invitee's inbox: `where email = $1 and status = 'pending'`. Address
  // first, since a composite index only serves the filter when the selective
  // column leads.
  const { indexes } = getTableConfig(invitation);
  const index = indexes.find(
    (candidate) => candidate.config.name === "invitation_email_status_idx",
  );
  assert.notEqual(index, undefined);

  const columns = index?.config.columns ?? [];
  assert.deepEqual(
    columns.map((column) => ("name" in column ? column.name : undefined)),
    ["email", "status"],
  );
});

test("a membership names both sides and neither is nullable", () => {
  // A membership belonging to nobody, or to no organization, is not a
  // membership; the many-to-many depends on both.
  const { columns } = getTableConfig(member);
  for (const name of ["organization_id", "user_id"]) {
    const column = columns.find((candidate) => candidate.name === name);
    assert.equal(column?.notNull, true, `${name} should be not null`);
  }
});

test("an invitation defaults to the member role", () => {
  // A row written without an explicit role must not grant ownership.
  const { columns } = getTableConfig(invitation);
  const role = columns.find((column) => column.name === "role");
  assert.equal(role?.default, "member");
});

test("a membership defaults to the member role", () => {
  const { columns } = getTableConfig(member);
  const role = columns.find((column) => column.name === "role");
  assert.equal(role?.default, "member");
});
