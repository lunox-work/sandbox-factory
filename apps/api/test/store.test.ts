import assert from "node:assert/strict";
import { test } from "node:test";

import { NotFoundError, createInMemoryStore } from "../src/store.js";

const seed = [
  {
    id: "todo_1",
    title: "first",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
  },
];

test("create assigns an id and starts not done", async () => {
  const store = createInMemoryStore();
  const created = await store.create("first");

  assert.match(created.id, /^todo_/);
  assert.equal(created.done, false);
  assert.deepEqual(await store.get(created.id), created);
});

test("create normalizes the title even when called directly", async () => {
  const store = createInMemoryStore();
  assert.equal((await store.create("  padded  ")).title, "padded");
});

test("create rejects a title that is empty after trimming", async () => {
  await assert.rejects(createInMemoryStore().create("   "));
});

test("ids do not collide across creates", async () => {
  const store = createInMemoryStore();
  const a = await store.create("a");
  const b = await store.create("b");

  assert.notEqual(a.id, b.id);
});

test("list returns newest first", async () => {
  const store = createInMemoryStore([
    {
      id: "old",
      title: "old",
      done: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "new",
      title: "new",
      done: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    (await store.list()).map((t) => t.id),
    ["new", "old"],
  );
});

test("get returns undefined for an unknown id", async () => {
  assert.equal(await createInMemoryStore().get("nope"), undefined);
});

test("update applies done without touching the title", async () => {
  const store = createInMemoryStore(seed);
  const updated = await store.update("todo_1", { done: true });

  assert.equal(updated.done, true);
  assert.equal(updated.title, "first");
});

test("update applies a title without touching done", async () => {
  const store = createInMemoryStore([{ ...seed[0]!, done: true }]);
  const updated = await store.update("todo_1", { title: "renamed" });

  assert.equal(updated.title, "renamed");
  assert.equal(updated.done, true, "done must be preserved");
});

test("update persists", async () => {
  const store = createInMemoryStore(seed);
  await store.update("todo_1", { done: true });

  assert.equal((await store.get("todo_1"))?.done, true);
});

test("update on an unknown id throws NotFoundError", async () => {
  await assert.rejects(
    createInMemoryStore().update("nope", { done: true }),
    (error: unknown) => error instanceof NotFoundError,
  );
});

test("remove deletes the todo", async () => {
  const store = createInMemoryStore(seed);
  await store.remove("todo_1");

  assert.equal(await store.get("todo_1"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("remove on an unknown id throws NotFoundError", async () => {
  await assert.rejects(
    createInMemoryStore().remove("nope"),
    (error: unknown) => error instanceof NotFoundError,
  );
});
