import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidTitleError } from "sandbox-factory";

import { createPostgresStore, NotFoundError } from "../src/store.js";
import { createFakeDb, row } from "./fake-db.js";

test("list maps rows to todos", async () => {
  const { db } = createFakeDb([row()]);
  assert.deepEqual(await createPostgresStore(db).list(), [
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
  await createPostgresStore(db).list();
  assert.equal(calls[0]?.ordered, true);
});

test("get returns undefined for a missing id", async () => {
  const { db } = createFakeDb([]);
  assert.equal(await createPostgresStore(db).get("nope"), undefined);
});

test("get returns the mapped todo", async () => {
  const { db } = createFakeDb([row()]);
  assert.equal((await createPostgresStore(db).get("todo_1"))?.id, "todo_1");
});

test("create normalizes the title before writing", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).create("  write tests  ");
  assert.equal(calls[0]?.values?.["title"], "write tests");
});

test("create rejects an invalid title", async () => {
  const { db } = createFakeDb([row()]);
  await assert.rejects(
    () => createPostgresStore(db).create("   "),
    InvalidTitleError,
  );
});

test("create throws when the insert returns nothing", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).create("write tests"),
    /Insert returned no row/,
  );
});

test("update writes only the fields present in the patch", async () => {
  const { db, calls } = createFakeDb([row({ done: true })]);
  await createPostgresStore(db).update("todo_1", { done: true });
  assert.deepEqual(calls[0]?.values, { done: true });
});

test("update normalizes a patched title", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).update("todo_1", { title: "  renamed  " });
  assert.deepEqual(calls[0]?.values, { title: "renamed" });
});

test("update writes both fields when both are patched", async () => {
  const { db, calls } = createFakeDb([row()]);
  await createPostgresStore(db).update("todo_1", {
    title: "renamed",
    done: true,
  });
  assert.deepEqual(calls[0]?.values, { title: "renamed", done: true });
});

test("update with an empty patch reads instead of issuing an empty UPDATE", async () => {
  const { db, calls } = createFakeDb([row()]);
  const updated = await createPostgresStore(db).update("todo_1", {});
  assert.equal(updated.id, "todo_1");
  assert.equal(calls[0]?.kind, "select");
});

test("update with an empty patch throws when the id is missing", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).update("nope", {}),
    NotFoundError,
  );
});

test("update throws NotFoundError when no row matched", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).update("nope", { done: true }),
    NotFoundError,
  );
});

test("remove throws NotFoundError when no row matched", async () => {
  const { db } = createFakeDb([]);
  await assert.rejects(
    () => createPostgresStore(db).remove("nope"),
    NotFoundError,
  );
});

test("remove succeeds when a row matched", async () => {
  const { db } = createFakeDb([row()]);
  await createPostgresStore(db).remove("todo_1");
});

test("NotFoundError names the id", () => {
  assert.match(new NotFoundError("todo_9").message, /todo_9/);
  assert.equal(new NotFoundError("todo_9").name, "NotFoundError");
});
