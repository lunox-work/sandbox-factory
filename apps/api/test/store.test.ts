import assert from "node:assert/strict";
import { test } from "node:test";

import { NotFoundError, createInMemoryStore } from "../src/store.js";

const OWNER = "user_1";
/** A second account, used to prove one user cannot reach another's rows. */
const OTHER = "user_2";

const seed = [
  {
    id: "todo_1",
    userId: OWNER,
    title: "first",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
  },
];

test("create assigns an id and starts not done", async () => {
  const store = createInMemoryStore();
  const created = await store.create(OWNER, "first");

  assert.match(created.id, /^todo_/);
  assert.equal(created.done, false);
  assert.deepEqual(await store.get(OWNER, created.id), created);
});

test("create normalizes the title even when called directly", async () => {
  const store = createInMemoryStore();
  assert.equal((await store.create(OWNER, "  padded  ")).title, "padded");
});

test("create rejects a title that is empty after trimming", async () => {
  await assert.rejects(createInMemoryStore().create(OWNER, "   "));
});

test("ids do not collide across creates", async () => {
  const store = createInMemoryStore();
  const a = await store.create(OWNER, "a");
  const b = await store.create(OWNER, "b");

  assert.notEqual(a.id, b.id);
});

test("list returns newest first", async () => {
  const store = createInMemoryStore([
    {
      id: "old",
      userId: OWNER,
      title: "old",
      done: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "new",
      userId: OWNER,
      title: "new",
      done: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    (await store.list(OWNER)).map((t) => t.id),
    ["new", "old"],
  );
});

test("get returns undefined for an unknown id", async () => {
  assert.equal(await createInMemoryStore().get(OWNER, "nope"), undefined);
});

test("update applies done without touching the title", async () => {
  const store = createInMemoryStore(seed);
  const updated = await store.update(OWNER, "todo_1", { done: true });

  assert.equal(updated.done, true);
  assert.equal(updated.title, "first");
});

test("update applies a title without touching done", async () => {
  const store = createInMemoryStore([{ ...seed[0]!, done: true }]);
  const updated = await store.update(OWNER, "todo_1", { title: "renamed" });

  assert.equal(updated.title, "renamed");
  assert.equal(updated.done, true, "done must be preserved");
});

test("update persists", async () => {
  const store = createInMemoryStore(seed);
  await store.update(OWNER, "todo_1", { done: true });

  assert.equal((await store.get(OWNER, "todo_1"))?.done, true);
});

test("update on an unknown id throws NotFoundError", async () => {
  await assert.rejects(
    createInMemoryStore().update(OWNER, "nope", { done: true }),
    (error: unknown) => error instanceof NotFoundError,
  );
});

test("remove deletes the todo", async () => {
  const store = createInMemoryStore(seed);
  await store.remove(OWNER, "todo_1");

  assert.equal(await store.get(OWNER, "todo_1"), undefined);
  assert.deepEqual(await store.list(OWNER), []);
});

test("remove on an unknown id throws NotFoundError", async () => {
  await assert.rejects(
    createInMemoryStore().remove(OWNER, "nope"),
    (error: unknown) => error instanceof NotFoundError,
  );
});

/**
 * Owner isolation. This store is a test double for the Postgres one, so it
 * must enforce the same boundary, or the route tests would pass against a
 * store more permissive than the one that runs.
 */
test("list returns only the caller's todos", async () => {
  const store = createInMemoryStore([
    ...seed,
    {
      id: "todo_2",
      userId: OTHER,
      title: "someone else's",
      done: false,
      createdAt: "2026-09-16T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    (await store.list(OWNER)).map((todo) => todo.id),
    ["todo_1"],
  );
  assert.deepEqual(
    (await store.list(OTHER)).map((todo) => todo.id),
    ["todo_2"],
  );
});

test("get does not return another user's todo", async () => {
  const store = createInMemoryStore(seed);
  assert.equal(await store.get(OTHER, "todo_1"), undefined);
});

test("update cannot touch another user's todo", async () => {
  const store = createInMemoryStore(seed);
  await assert.rejects(
    store.update(OTHER, "todo_1", { title: "hijacked" }),
    (error: unknown) => error instanceof NotFoundError,
  );
  // And the row is untouched.
  assert.equal((await store.get(OWNER, "todo_1"))?.title, "first");
});

test("remove cannot delete another user's todo", async () => {
  const store = createInMemoryStore(seed);
  await assert.rejects(
    store.remove(OTHER, "todo_1"),
    (error: unknown) => error instanceof NotFoundError,
  );
  assert.notEqual(await store.get(OWNER, "todo_1"), undefined);
});

test("create files the todo under the caller, not a shared list", async () => {
  const store = createInMemoryStore();
  const mine = await store.create(OWNER, "mine");

  assert.equal(await store.get(OTHER, mine.id), undefined);
  assert.deepEqual(await store.list(OTHER), []);
});

test("the todo returned to a caller carries no owner field", async () => {
  // The HTTP layer serializes whatever the store hands back.
  const store = createInMemoryStore(seed);
  const todo = await store.get(OWNER, "todo_1");

  assert.equal(todo !== undefined && "userId" in todo, false);
});
