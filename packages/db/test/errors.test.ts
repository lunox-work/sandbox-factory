import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guardRepositoryDelete,
  isForeignKeyViolation,
  isUniqueViolation,
  NotFoundError,
  RepositoryInUseError,
} from "../src/errors.js";

test("NotFoundError names the id it was raised for", () => {
  // The id reaches the log and, through the route's error handler, the 404
  // body — so a missing record is diagnosable without a database session.
  const error = new NotFoundError("jrc_9");
  assert.match(error.message, /jrc_9/);
  assert.equal(error.name, "NotFoundError");
});

test("NotFoundError is an Error, so `instanceof` routing works", () => {
  // `errorHandler` branches on `instanceof`; a plain object with the right
  // shape would fall through to a 500.
  const error = new NotFoundError("jrb_1");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof NotFoundError);
});

test("isUniqueViolation recognises Postgres' duplicate-key code", () => {
  // `23505` is both a plain unique constraint and what the handle triggers
  // raise when a claim is lost.
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ code: "23503" }), false);
  assert.equal(isUniqueViolation(new Error("no code")), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation("23505"), false);
});

test("isUniqueViolation sees through the error Drizzle wraps around the driver's", () => {
  // drizzle-orm >= 0.44 throws a `DrizzleQueryError` with no `code` of its
  // own; the SQLSTATE is on `cause`. Without this a lost race was a 500.
  const wrapped = Object.assign(new Error("Failed query: insert ..."), {
    cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
  });
  assert.equal(isUniqueViolation(wrapped), true);
  assert.equal(
    isUniqueViolation({ message: "Failed query", cause: { code: "23503" } }),
    false,
  );
  // A cycle, or a chain deeper than any real wrapper, ends rather than spins.
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(isUniqueViolation(loop), false);
  assert.equal(
    isUniqueViolation({
      cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } },
    }),
    false,
  );
});

test("isForeignKeyViolation recognises 23503, wrapped or not", () => {
  assert.equal(isForeignKeyViolation({ code: "23503" }), true);
  assert.equal(isForeignKeyViolation({ cause: { code: "23503" } }), true);
  assert.equal(isForeignKeyViolation({ code: "23505" }), false);
  assert.equal(isForeignKeyViolation(undefined), false);
});

test("a repository delete refused by sandbox provenance becomes RepositoryInUseError", async () => {
  // Only sandbox tables reference repositories without a cascade, so the
  // route can say why instead of answering 500.
  const refused = guardRepositoryDelete(async () => {
    throw Object.assign(new Error("Failed query: delete ..."), {
      cause: { code: "23503" },
    });
  });
  await assert.rejects(refused, RepositoryInUseError);
  await refused.catch((error: RepositoryInUseError) => {
    assert.equal(error.code, "repository_in_use");
    assert.match(error.message, /sandbox/);
  });
  await assert.rejects(
    guardRepositoryDelete(async () => {
      throw new Error("connection reset");
    }),
    /connection reset/,
  );
  assert.equal(await guardRepositoryDelete(async () => 3), 3);
});
