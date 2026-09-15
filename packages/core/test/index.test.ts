import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidTitleError,
  TITLE_MAX_LENGTH,
  TODO_FILTERS,
  countTodos,
  filterTodos,
  isTodoFilter,
  isValidTitle,
  matchesFilter,
  normalizeTitle,
  rename,
  toggle,
  type Todo,
} from "../src/index.js";

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: "todo_1",
    title: "write tests",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

test("normalizeTitle trims surrounding whitespace", () => {
  assert.equal(normalizeTitle("  buy milk  "), "buy milk");
});

test("normalizeTitle rejects a title that is empty after trimming", () => {
  for (const raw of ["", "   ", "\t\n"]) {
    assert.throws(() => normalizeTitle(raw), InvalidTitleError);
  }
});

test("normalizeTitle rejects a title over the cap but accepts one at it", () => {
  assert.equal(
    normalizeTitle("x".repeat(TITLE_MAX_LENGTH)).length,
    TITLE_MAX_LENGTH,
  );
  assert.throws(
    () => normalizeTitle("x".repeat(TITLE_MAX_LENGTH + 1)),
    InvalidTitleError,
  );
});

test("isValidTitle agrees with normalizeTitle", () => {
  for (const raw of ["ok", "  ok  ", "x".repeat(TITLE_MAX_LENGTH)]) {
    assert.ok(isValidTitle(raw), `${raw.slice(0, 12)} should be valid`);
  }
  for (const raw of ["", "   ", "x".repeat(TITLE_MAX_LENGTH + 1)]) {
    assert.equal(isValidTitle(raw), false);
  }
});

test("toggle flips done and leaves the original alone", () => {
  const before = todo();
  const after = toggle(before);

  assert.equal(after.done, true);
  assert.equal(before.done, false, "input must not be mutated");
  assert.equal(after.id, before.id);
});

test("toggle round-trips", () => {
  assert.deepEqual(toggle(toggle(todo())), todo());
});

test("rename normalizes the new title", () => {
  assert.equal(rename(todo(), "  new title  ").title, "new title");
});

test("rename rejects an invalid title", () => {
  assert.throws(() => rename(todo(), "  "), InvalidTitleError);
});

test("matchesFilter splits active from completed", () => {
  const active = todo({ done: false });
  const done = todo({ done: true });

  assert.ok(matchesFilter(active, "all"));
  assert.ok(matchesFilter(done, "all"));
  assert.ok(matchesFilter(active, "active"));
  assert.equal(matchesFilter(done, "active"), false);
  assert.ok(matchesFilter(done, "completed"));
  assert.equal(matchesFilter(active, "completed"), false);
});

test("filterTodos returns only the matching todos", () => {
  const todos = [
    todo({ id: "a" }),
    todo({ id: "b", done: true }),
    todo({ id: "c" }),
  ];

  assert.deepEqual(
    filterTodos(todos, "all").map((t) => t.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    filterTodos(todos, "active").map((t) => t.id),
    ["a", "c"],
  );
  assert.deepEqual(
    filterTodos(todos, "completed").map((t) => t.id),
    ["b"],
  );
});

test("countTodos totals add up", () => {
  const counts = countTodos([
    todo(),
    todo({ done: true }),
    todo({ done: true }),
  ]);

  assert.deepEqual(counts, { total: 3, active: 1, completed: 2 });
  assert.equal(counts.active + counts.completed, counts.total);
});

test("countTodos handles an empty list", () => {
  assert.deepEqual(countTodos([]), { total: 0, active: 0, completed: 0 });
});

test("isTodoFilter accepts every known filter and nothing else", () => {
  for (const filter of TODO_FILTERS) {
    assert.ok(isTodoFilter(filter));
  }
  for (const value of ["archived", "", 3, null, undefined, {}]) {
    assert.equal(isTodoFilter(value), false);
  }
});
