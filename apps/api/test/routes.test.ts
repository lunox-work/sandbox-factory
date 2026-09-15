import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/routes.js";
import { createInMemoryStore } from "../src/store.js";

const seed = [
  {
    id: "todo_1",
    title: "write tests",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
  },
];

function app(todos = seed) {
  return createApp({
    store: createInMemoryStore(todos),
    corsOrigins: ["http://localhost:5173"],
  });
}

function json(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("GET /health reports ok", async () => {
  const res = await app().request("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("GET /api/v1/todos returns the seeded todos", async () => {
  const res = await app().request("/api/v1/todos");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { todos: unknown[] };
  assert.equal(body.todos.length, 1);
});

test("GET one todo by id", async () => {
  const res = await app().request("/api/v1/todos/todo_1");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { title: string }).title, "write tests");
});

test("GET an unknown id is a 404 with a message", async () => {
  const res = await app().request("/api/v1/todos/nope");
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /No todo/);
});

test("POST creates a todo, not done, and returns 201", async () => {
  const res = await app().request("/api/v1/todos", json({ title: "buy milk" }));

  assert.equal(res.status, 201);
  const body = (await res.json()) as { title: string; done: boolean };
  assert.equal(body.title, "buy milk");
  assert.equal(body.done, false);
});

test("POST trims the title", async () => {
  const res = await app().request(
    "/api/v1/todos",
    json({ title: "  padded  " }),
  );
  assert.equal(((await res.json()) as { title: string }).title, "padded");
});

test("POST with an empty title is a 400 carrying the schema's message", async () => {
  const res = await app().request("/api/v1/todos", json({ title: "   " }));

  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /needs a title/,
  );
});

test("POST with an overlong title is a 400", async () => {
  const res = await app().request(
    "/api/v1/todos",
    json({ title: "x".repeat(201) }),
  );
  assert.equal(res.status, 400);
});

test("POST with a malformed body is a 400, not a crash", async () => {
  const res = await app().request("/api/v1/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{{{",
  });

  assert.equal(res.status, 400);
});

test("PATCH marks a todo done", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ done: true }),
    method: "PATCH",
  });

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { done: boolean }).done, true);
});

test("PATCH renames a todo", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ title: "renamed" }),
    method: "PATCH",
  });

  assert.equal(((await res.json()) as { title: string }).title, "renamed");
});

test("PATCH can change title and done together", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({ title: "both", done: true }),
    method: "PATCH",
  });

  const body = (await res.json()) as { title: string; done: boolean };
  assert.equal(body.title, "both");
  assert.equal(body.done, true);
});

test("PATCH with an empty body is a 400", async () => {
  const res = await app().request("/api/v1/todos/todo_1", {
    ...json({}),
    method: "PATCH",
  });

  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /Provide a title/,
  );
});

test("PATCH an unknown id is a 404", async () => {
  const res = await app().request("/api/v1/todos/nope", {
    ...json({ done: true }),
    method: "PATCH",
  });

  assert.equal(res.status, 404);
});

test("DELETE removes the todo and returns 204 with no body", async () => {
  const server = app();

  const res = await server.request("/api/v1/todos/todo_1", {
    method: "DELETE",
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");

  const after = await server.request("/api/v1/todos");
  assert.deepEqual(await after.json(), { todos: [] });
});

test("DELETE an unknown id is a 404", async () => {
  const res = await app().request("/api/v1/todos/nope", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("DELETE twice is a 404 the second time", async () => {
  const server = app();
  await server.request("/api/v1/todos/todo_1", { method: "DELETE" });
  const res = await server.request("/api/v1/todos/todo_1", {
    method: "DELETE",
  });

  assert.equal(res.status, 404);
});

test("an unknown route is a 404 in JSON, not HTML", async () => {
  const res = await app().request("/api/v1/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
});

test("CORS allows the configured origin", async () => {
  const res = await app().request("/api/v1/todos", {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(
    res.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
});
