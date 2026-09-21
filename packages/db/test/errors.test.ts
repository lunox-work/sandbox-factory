import assert from "node:assert/strict";
import { test } from "node:test";

import { NotFoundError } from "../src/errors.js";

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
