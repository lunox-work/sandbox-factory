import assert from "node:assert/strict";
import { test } from "node:test";

import { objectStoreConfig, parseEnv } from "../src/env.js";

/**
 * DATABASE_URL is required, so every case that is not about it has to supply
 * one. Kept as a constant rather than repeated so the tests below read as
 * being about the field they actually exercise.
 */
const DATABASE_URL = "postgres://postgres:postgres@localhost:5432/test";
const required = { DATABASE_URL };

test("parseEnv applies defaults when only the required vars are set", () => {
  const env = parseEnv(required);
  assert.equal(env.PORT, 4000);
  assert.deepEqual(env.CORS_ORIGINS, ["http://localhost:5173"]);
  assert.equal(env.S3_BUCKET, "sandbox-factory");
  assert.equal(env.S3_REGION, "us-east-1");
});

test("parseEnv coerces PORT from a string", () => {
  assert.equal(parseEnv({ ...required, PORT: "8080" }).PORT, 8080);
});

test("parseEnv rejects a non-numeric PORT with a readable message", () => {
  assert.throws(
    () => parseEnv({ ...required, PORT: "not-a-port" }),
    /Invalid environment configuration/,
  );
});

test("parseEnv splits and trims CORS_ORIGINS", () => {
  assert.deepEqual(
    parseEnv({ ...required, CORS_ORIGINS: "https://a.test, https://b.test ," })
      .CORS_ORIGINS,
    ["https://a.test", "https://b.test"],
  );
});

test("parseEnv rejects a missing DATABASE_URL", () => {
  // The server has no in-memory fallback, so an unset DATABASE_URL must fail
  // at boot rather than starting a process that cannot serve a request.
  assert.throws(() => parseEnv({}), /DATABASE_URL/);
});

test("parseEnv rejects an empty DATABASE_URL", () => {
  assert.throws(() => parseEnv({ DATABASE_URL: "" }), /DATABASE_URL/);
});

test("parseEnv keeps DATABASE_URL verbatim", () => {
  assert.equal(parseEnv(required).DATABASE_URL, DATABASE_URL);
});

test("objectStoreConfig is undefined when S3 is not configured", () => {
  assert.equal(objectStoreConfig(parseEnv(required)), undefined);
});

test("objectStoreConfig is undefined when only some S3 vars are set", () => {
  for (const partial of [
    { S3_ENDPOINT: "http://localhost:8333" },
    { S3_ENDPOINT: "http://localhost:8333", S3_ACCESS_KEY_ID: "key" },
    { S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret" },
  ]) {
    assert.equal(
      objectStoreConfig(parseEnv({ ...required, ...partial })),
      undefined,
    );
  }
});

test("objectStoreConfig returns the config when S3 is fully configured", () => {
  assert.deepEqual(
    objectStoreConfig(
      parseEnv({
        ...required,
        S3_ENDPOINT: "http://localhost:8333",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    ),
    {
      endpoint: "http://localhost:8333",
      bucket: "sandbox-factory",
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "us-east-1",
    },
  );
});
