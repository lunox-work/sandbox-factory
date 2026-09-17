import assert from "node:assert/strict";
import { test } from "node:test";

import { createConnection } from "../src/client.js";

/**
 * Nothing listens on port 1: `postgres()` is lazy, so a pool can be built and
 * drained without a server. Only construction and teardown are covered here.
 */
const UNUSED_URL = "postgres://user:pass@127.0.0.1:1/nothing";

test("createConnection returns a database handle and a close function", () => {
  const connection = createConnection({ url: UNUSED_URL });
  assert.equal(typeof connection.db, "object");
  assert.equal(typeof connection.close, "function");
  return connection.close();
});

test("close resolves on a pool that never connected", async () => {
  const connection = createConnection({ url: UNUSED_URL });
  // Must not hang or throw: the API calls this on SIGTERM.
  await connection.close();
});

test("close is safe to call twice", async () => {
  const connection = createConnection({ url: UNUSED_URL });
  await connection.close();
  await connection.close();
});

test("createConnection accepts an explicit pool size", async () => {
  const connection = createConnection({ url: UNUSED_URL, max: 1 });
  assert.equal(typeof connection.db, "object");
  await connection.close();
});

test("the handle exposes drizzle's query builder", async () => {
  const connection = createConnection({ url: UNUSED_URL });
  // `select` is the store's entry point; undefined if drizzle is not wired.
  assert.equal(typeof connection.db.select, "function");
  await connection.close();
});
