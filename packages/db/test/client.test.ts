import assert from "node:assert/strict";
import { test } from "node:test";

import { createConnection } from "../src/client.js";

/**
 * Port 1 has nothing listening, and that is the point: `postgres()` is lazy,
 * so a pool can be built and drained without a server. These tests cover
 * construction and teardown — the parts that do not need a database — and
 * stop there. Whether a query actually round-trips is verified against a real
 * Postgres with `make migrate`, not here: no test may depend on a container.
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
  // Must not hang or throw: the API calls this on SIGTERM, and a rejection
  // there would stop the process exiting cleanly.
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
  // `select` is the entry point the store uses; if drizzle were not wired to
  // the pool this would be undefined.
  assert.equal(typeof connection.db.select, "function");
  await connection.close();
});
