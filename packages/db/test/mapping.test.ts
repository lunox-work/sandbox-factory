import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidTitleError } from "sandbox-factory";

import {
  generateId,
  ID_PREFIXES,
  newTodoRow,
  rowToTodo,
} from "../src/mapping.js";

test("rowToTodo converts the timestamp to an ISO string", () => {
  assert.deepEqual(
    rowToTodo({
      id: "todo_1",
      userId: "user_1",
      title: "write tests",
      done: false,
      createdAt: new Date("2026-09-16T00:00:00.000Z"),
    }),
    {
      id: "todo_1",
      title: "write tests",
      done: false,
      createdAt: "2026-09-16T00:00:00.000Z",
    },
  );
});

test("rowToTodo preserves done", () => {
  const todo = rowToTodo({
    id: "todo_2",
    userId: "user_1",
    title: "done thing",
    done: true,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  });
  assert.equal(todo.done, true);
});

test("rowToTodo does not leak the owner into the DTO", () => {
  // `user_id` is storage bookkeeping; the client already knows who it is.
  const todo = rowToTodo({
    id: "todo_1",
    userId: "user_1",
    title: "write tests",
    done: false,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  });
  assert.equal("userId" in todo, false);
});

test("newTodoRow records the owner", () => {
  assert.equal(newTodoRow("user_1", "buy milk", "todo_1").userId, "user_1");
});

test("newTodoRow normalizes the title", () => {
  assert.equal(
    newTodoRow("user_1", "  buy milk  ", "todo_1").title,
    "buy milk",
  );
});

test("newTodoRow starts a todo undone", () => {
  assert.equal(newTodoRow("user_1", "buy milk", "todo_1").done, false);
});

test("newTodoRow rejects a title the domain would reject", () => {
  assert.throws(() => newTodoRow("user_1", "   ", "todo_1"), InvalidTitleError);
});

test("newTodoRow generates an id when none is given", () => {
  assert.match(String(newTodoRow("user_1", "buy milk").id), /^todo_/);
});

test("generateId returns unique prefixed ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId()));
  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.match(id, /^todo_/);
  }
});

test("generateId takes the prefix of the table it is for", () => {
  // An id that leaks into a log or a URL says what it is, and a board id
  // passed where an issue id belongs is visible rather than a silent 404.
  assert.match(generateId("jrb"), /^jrb_/);
  assert.match(generateId("bpr"), /^bpr_/);
});

test("every declared prefix produces a distinct, well-formed id", () => {
  const ids = ID_PREFIXES.map((prefix) => generateId(prefix));

  assert.equal(new Set(ids).size, ID_PREFIXES.length);
  for (const [index, id] of ids.entries()) {
    // `<prefix>_<uuid>`, and the uuid half is what makes it unique.
    assert.match(id, new RegExp(`^${ID_PREFIXES[index]}_[0-9a-f-]{36}$`));
  }
});
