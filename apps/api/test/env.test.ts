import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEnv } from "../src/env.js";

test("parseEnv applies defaults when nothing is set", () => {
  const env = parseEnv({});
  assert.equal(env.PORT, 4000);
  assert.deepEqual(env.CORS_ORIGINS, ["http://localhost:5173"]);
});

test("parseEnv coerces PORT from a string", () => {
  assert.equal(parseEnv({ PORT: "8080" }).PORT, 8080);
});

test("parseEnv rejects a non-numeric PORT with a readable message", () => {
  assert.throws(
    () => parseEnv({ PORT: "not-a-port" }),
    /Invalid environment configuration/,
  );
});

test("parseEnv splits and trims CORS_ORIGINS", () => {
  assert.deepEqual(
    parseEnv({ CORS_ORIGINS: "https://a.test, https://b.test ," }).CORS_ORIGINS,
    ["https://a.test", "https://b.test"],
  );
});
