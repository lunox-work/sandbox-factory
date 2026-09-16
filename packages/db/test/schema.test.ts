import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { todos, userEmail } from "../src/schema.js";

/**
 * Schema invariants that only fail at runtime.
 *
 * Like `auth-schema.test.ts`, these look like tests of Drizzle and are not:
 * each pins a property that nothing else in the build would catch. A missing
 * index degrades silently into a sequential scan, and a nullable owner column
 * would let an unowned todo exist — which is the state this schema was changed
 * to make unrepresentable.
 */

test("todos.user_id is not nullable", () => {
  // The whole point of the column. A nullable owner would allow rows that
  // belong to nobody and are therefore visible to whoever queries without a
  // filter — the exact shape of the bug it was added to close.
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
  // Every read the store issues filters on `user_id`, and the list also orders
  // by `created_at desc`. Without this index that list is a sequential scan
  // plus a sort, which stays invisible until the table is large.
  const { indexes } = getTableConfig(todos);
  const index = indexes.find(
    (candidate) => candidate.config.name === "todos_user_id_created_at_idx",
  );
  assert.notEqual(index, undefined);

  // Two parts, owner first: a composite index is only usable for the `where`
  // when the filtered column leads. The second is `desc(created_at)`, which
  // Drizzle models as an SQL expression rather than a column, so it carries no
  // `name` to assert on — its presence is what matters.
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
  // Partial unique index on `user_id where is_primary`: two primaries would
  // make `user.email` ambiguous about which row it mirrors.
  const { indexes } = getTableConfig(userEmail);
  const primary = indexes.find(
    (candidate) => candidate.config.name === "user_email_one_primary",
  );
  assert.notEqual(primary, undefined);
  assert.equal(primary?.config.unique, true);
  assert.notEqual(primary?.config.where, undefined);
});
