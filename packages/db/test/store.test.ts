import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidTitleError } from "sandbox-factory";

import { createPostgresStore, NotFoundError } from "../src/store.js";
import { createFakeDb, row } from "./fake-db.js";

test("list maps rows to todos", async () => {
  const { db } = createFakeDb([row()]);
  assert.deepEqual(await createPostgresStore(db).list("user_1"), [
    {
      id: "todo_1",
      title: "write tests",
      done: false,
      createdAt: "2026-09-16T00:00:00.000Z",
    },
  ]);
});

test("list orders newest first", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).list("user_1");
  assert.equal(calls[0]?.ordered, true);
});

test("get returns undefined for a missing id", async () => {
  const { db } = createFakeDb([]);
  assert.equal(await createPostgresStore(db).get("user_1", "nope"), undefined);
});

test("get returns the mapped todo", async () => {
  const { db } = createFakeDb([row()]);
  assert.equal(
    (await createPostgresStore(db).get("user_1", "todo_1"))?.id,
    "todo_1",
  );
});

test("create normalizes the title before writing", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).create("user_1", "  write tests  ");
  assert.equal(calls[0]?.values?.["title"], "write tests");
});

test("create rejects an invalid title", async () => {
  const { db } = createFakeDb([row()]);
  await assert.rejects(
    () => createPostgresStore(db).create("user_1", "   "),
    InvalidTitleError,
  );
});

test("create throws when the insert returns nothing", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).create("user_1", "write tests"),
    /Insert returned no row/,
  );
});

test("update writes only the fields present in the patch", async () => {
  const { db, calls } = createFakeDb([row({ done: true })]);
  await createPostgresStore(db).update("user_1", "todo_1", { done: true });
  assert.deepEqual(calls[0]?.values, { done: true });
});

test("update normalizes a patched title", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).update("user_1", "todo_1", {
    title: "  renamed  ",
  });
  assert.deepEqual(calls[0]?.values, { title: "renamed" });
});

test("update writes both fields when both are patched", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).update("user_1", "todo_1", {
    title: "renamed",
    done: true,
  });
  assert.deepEqual(calls[0]?.values, { title: "renamed", done: true });
});

test("update with an empty patch reads instead of issuing an empty UPDATE", async () => {
  const { db, calls } = createFakeDb([row()]);
  const updated = await createPostgresStore(db).update("user_1", "todo_1", {});
  assert.equal(updated.id, "todo_1");
  assert.equal(calls[0]?.kind, "select");
});

test("update with an empty patch throws when the id is missing", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).update("user_1", "nope", {}),
    NotFoundError,
  );
});

test("update throws NotFoundError when no row matched", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).update("user_1", "nope", { done: true }),
    NotFoundError,
  );
});

test("remove throws NotFoundError when no row matched", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).remove("user_1", "nope"),
    NotFoundError,
  );
});

test("remove succeeds when a row matched", async () => {
  const { db } = createFakeDb([row()]);
  await createPostgresStore(db).remove("user_1", "todo_1");
});

/**
 * Owner scoping.
 *
 * The fake does not interpret SQL, so these prove the weaker property that a
 * predicate is applied at all on every path that touches a row. That is enough
 * to catch the regression that matters — a query that stops filtering by owner
 * and starts serving the whole table — which is precisely the bug this column
 * was added to fix.
 */
test("create records the owner on the new row", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).create("user_1", "write tests");
  assert.equal(calls[0]?.values?.["userId"], "user_1");
});

test("list filters by owner", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).list("user_1");
  assert.equal(calls[0]?.filtered, true);
});

test("get filters by owner", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).get("user_1", "todo_1");
  assert.equal(calls[0]?.filtered, true);
});

test("update filters by owner", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).update("user_1", "todo_1", { done: true });
  assert.equal(calls[0]?.filtered, true);
});

test("remove filters by owner", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).remove("user_1", "todo_1");
  assert.equal(calls[0]?.filtered, true);
});

test("another user's id is reported as missing, not forbidden", async () => {
  // No row comes back, which is what Postgres returns when the id exists but
  // belongs to someone else — the owner is part of the WHERE clause.
  const { db } = createFakeDb([]);
  const store = createPostgresStore(db);
  assert.equal(await store.get("user_2", "todo_1"), undefined);
  await assert.rejects(
    () => store.update("user_2", "todo_1", { done: true }),
    NotFoundError,
  );
  await assert.rejects(() => store.remove("user_2", "todo_1"), NotFoundError);
});

test("NotFoundError names the id", () => {
  assert.match(new NotFoundError("todo_9").message, /todo_9/);
  assert.equal(new NotFoundError("todo_9").name, "NotFoundError");
});
