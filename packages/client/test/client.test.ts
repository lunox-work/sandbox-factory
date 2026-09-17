import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, TodoClient } from "../src/index.js";

const todo = {
  id: "todo_1",
  title: "write tests",
  done: false,
  createdAt: "2026-09-16T00:00:00.000Z",
};

/** A fetch stub that records what it was called with. */
function stubFetch(response: {
  status?: number;
  body?: unknown;
  text?: string;
}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const body =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    // 204 and 205 must carry a null body, or the Response constructor throws.
    return new Response(status === 204 || status === 205 ? null : body, {
      status,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("listTodos unwraps the envelope", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [todo] } });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  assert.deepEqual(await client.listTodos(), [todo]);
  assert.equal(calls[0]?.url, "https://api.test/api/v1/todos");
});

test("a trailing slash on baseUrl does not produce a doubled slash", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({ baseUrl: "https://api.test///", fetch });

  await client.listTodos();
  assert.equal(calls[0]?.url, "https://api.test/api/v1/todos");
});

test("a baseUrl of only slashes trims to empty", async () => {
  // Pins an edge case of the hand-rolled trim (see `trimTrailingSlashes`).
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({ baseUrl: "///", fetch });

  await client.listTodos();
  assert.equal(calls[0]?.url, "/api/v1/todos");
});

test("a long run of slashes mid-url is left alone and returns promptly", async () => {
  // The quadratic case for the old regex: a long run of slashes not at the
  // end, ~2.3s for 80k. The time bound is the assertion that matters.
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const inner = "/".repeat(80_000);

  // Start the timer before construction: the trim runs in the constructor.
  const started = Date.now();
  const client = new TodoClient({
    baseUrl: `https://api.test${inner}x`,
    fetch,
  });

  await client.listTodos();

  assert.ok(
    Date.now() - started < 1000,
    "trimming should not be quadratic in the length of a slash run",
  );
  assert.equal(calls[0]?.url, `https://api.test${inner}x/api/v1/todos`);
});

test("the bearer token is attached when getToken returns one", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({
    baseUrl: "https://api.test",
    fetch,
    getToken: () => Promise.resolve("tok_123"),
  });

  await client.listTodos();
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("Authorization"),
    "Bearer tok_123",
  );
});

test("no Authorization header is sent when signed out", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await client.listTodos();
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), null);
});

test("ids are URL-encoded so a slash cannot escape the path", async () => {
  const { fetch, calls } = stubFetch({ body: todo });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await client.getTodo("a/../../admin");
  assert.equal(
    calls[0]?.url,
    "https://api.test/api/v1/todos/a%2F..%2F..%2Fadmin",
  );
});

test("createTodo posts JSON with the trimmed title", async () => {
  const { fetch, calls } = stubFetch({ body: todo });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await client.createTodo({ title: "  write tests  " });
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("Content-Type"),
    "application/json",
  );
  assert.equal(calls[0]?.init?.body, JSON.stringify({ title: "write tests" }));
});

test("createTodo validates the title before making a request", async () => {
  const { fetch, calls } = stubFetch({ body: todo });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.createTodo({ title: "   " }));
  assert.equal(calls.length, 0, "an invalid title must not reach the network");
});

test("setDone patches only the done flag", async () => {
  const { fetch, calls } = stubFetch({ body: { ...todo, done: true } });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  const updated = await client.setDone("todo_1", true);
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.equal(calls[0]?.init?.body, JSON.stringify({ done: true }));
  assert.equal(updated.done, true);
});

test("updateTodo rejects an empty patch before making a request", async () => {
  const { fetch, calls } = stubFetch({ body: todo });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.updateTodo("todo_1", {}));
  assert.equal(calls.length, 0);
});

test("deleteTodo issues a DELETE and tolerates an empty body", async () => {
  const { fetch, calls } = stubFetch({ status: 204 });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await client.deleteTodo("todo_1");
  assert.equal(calls[0]?.init?.method, "DELETE");
  assert.equal(calls[0]?.url, "https://api.test/api/v1/todos/todo_1");
});

test("a 404 is flagged as not found", async () => {
  const { fetch } = stubFetch({
    status: 404,
    body: { error: 'No todo with id "nope".' },
  });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.deleteTodo("nope"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.ok(error.isNotFound);
    assert.equal(error.isUnauthorized, false);
    assert.match(error.message, /No todo/);
    return true;
  });
});

test("a 401 is flagged as unauthorized", async () => {
  const { fetch } = stubFetch({
    status: 401,
    body: { error: "Sign in first." },
  });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.listTodos(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.ok(error.isUnauthorized);
    return true;
  });
});

test("a non-JSON body produces a readable error, not a parse crash", async () => {
  const { fetch } = stubFetch({ status: 502, text: "<html>gateway</html>" });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.listTodos(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.message, /Expected JSON/);
    return true;
  });
});

test("a response of the wrong shape is rejected rather than passed through", async () => {
  const { fetch } = stubFetch({ body: { todos: [{ id: "todo_1" }] } });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await assert.rejects(client.listTodos());
});

test("requests send cookies by default", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({ baseUrl: "https://api.test", fetch });

  await client.listTodos();

  // Not fetch's default "same-origin", which drops the session cookie
  // cross-origin in production.
  assert.equal(calls[0]?.init?.credentials, "include");
});

test("credentials can be overridden", async () => {
  const { fetch, calls } = stubFetch({ body: { todos: [] } });
  const client = new TodoClient({
    baseUrl: "https://api.test",
    fetch,
    credentials: "omit",
  });

  await client.listTodos();

  assert.equal(calls[0]?.init?.credentials, "omit");
});
