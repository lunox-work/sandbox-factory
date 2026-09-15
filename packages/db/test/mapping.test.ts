import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidTitleError } from "sandbox-factory";

import { generateId, newTodoRow, rowToTodo } from "../src/mapping.js";

test("rowToTodo converts the timestamp to an ISO string", () => {
  assert.deepEqual(
    rowToTodo({
      id: "todo_1",
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
    title: "done thing",
    done: true,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  });
  assert.equal(todo.done, true);
});

test("newTodoRow normalizes the title", () => {
  assert.equal(newTodoRow("  buy milk  ", "todo_1").title, "buy milk");
});

test("newTodoRow starts a todo undone", () => {
  assert.equal(newTodoRow("buy milk", "todo_1").done, false);
});

test("newTodoRow rejects a title the domain would reject", () => {
  assert.throws(() => newTodoRow("   ", "todo_1"), InvalidTitleError);
});

test("newTodoRow generates an id when none is given", () => {
  assert.match(String(newTodoRow("buy milk").id), /^todo_/);
});

test("generateId returns unique prefixed ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId()));
  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.match(id, /^todo_/);
  }
});
