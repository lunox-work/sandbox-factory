import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTodoSchema,
  todoSchema,
  updateTodoSchema,
} from "../src/index.js";

const valid = {
  id: "todo_1",
  title: "write tests",
  done: false,
  createdAt: "2026-09-16T00:00:00.000Z",
};

test("todoSchema accepts a well-formed todo", () => {
  assert.deepEqual(todoSchema.parse(valid), valid);
});

test("todoSchema rejects a non-boolean done", () => {
  assert.equal(todoSchema.safeParse({ ...valid, done: "yes" }).success, false);
});

test("todoSchema rejects a non-ISO createdAt", () => {
  assert.equal(
    todoSchema.safeParse({ ...valid, createdAt: "yesterday" }).success,
    false,
  );
});

test("createTodoSchema trims the title", () => {
  assert.deepEqual(createTodoSchema.parse({ title: "  buy milk  " }), {
    title: "buy milk",
  });
});

test("createTodoSchema rejects empty and whitespace-only titles", () => {
  for (const title of ["", "   "]) {
    assert.equal(createTodoSchema.safeParse({ title }).success, false);
  }
});

test("createTodoSchema rejects an overlong title", () => {
  assert.equal(
    createTodoSchema.safeParse({ title: "x".repeat(201) }).success,
    false,
  );
});

test("updateTodoSchema accepts either field alone, or both", () => {
  assert.ok(updateTodoSchema.safeParse({ done: true }).success);
  assert.ok(updateTodoSchema.safeParse({ title: "renamed" }).success);
  assert.ok(
    updateTodoSchema.safeParse({ title: "renamed", done: true }).success,
  );
});

test("updateTodoSchema rejects an empty body", () => {
  const result = updateTodoSchema.safeParse({});
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /Provide a title/);
  }
});

test("updateTodoSchema rejects an invalid title", () => {
  assert.equal(updateTodoSchema.safeParse({ title: "   " }).success, false);
});
