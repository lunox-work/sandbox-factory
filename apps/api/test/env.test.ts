import assert from "node:assert/strict";
import { test } from "node:test";

import { objectStoreConfig, parseEnv } from "../src/env.js";

/**
 * DATABASE_URL and the auth vars are required, so every case that is not about
 * one of them has to supply all of them. Kept as a constant rather than
 * repeated so the tests below read as being about the field they actually
 * exercise.
 */
const DATABASE_URL = "postgres://postgres:postgres@localhost:5432/test";
/** Long enough to clear the 32-character minimum on the signing secret. */
const SECRET = "0123456789abcdef0123456789abcdef";
const required = {
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:4000",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  ATLASSIAN_CLIENT_ID: "atlassian-client-id",
  ATLASSIAN_CLIENT_SECRET: "atlassian-client-secret",
};

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
  const { DATABASE_URL: _omitted, ...rest } = required;
  assert.throws(() => parseEnv(rest), /DATABASE_URL/);
});

test("parseEnv rejects an empty DATABASE_URL", () => {
  assert.throws(
    () => parseEnv({ ...required, DATABASE_URL: "" }),
    /DATABASE_URL/,
  );
});

test("parseEnv rejects a signing secret shorter than 32 characters", () => {
  // A short secret is the kind of thing that works fine in dev and is a real
  // weakness in production, so it fails at boot rather than never at all.
  assert.throws(
    () => parseEnv({ ...required, BETTER_AUTH_SECRET: "too-short" }),
    /BETTER_AUTH_SECRET/,
  );
});

test("parseEnv rejects a BETTER_AUTH_URL that is not absolute", () => {
  // Better Auth builds provider callback URLs from this; a relative value
  // produces a redirect_uri mismatch at Google rather than an error here.
  assert.throws(
    () => parseEnv({ ...required, BETTER_AUTH_URL: "/api/auth" }),
    /BETTER_AUTH_URL/,
  );
});

test("parseEnv requires each OAuth credential", () => {
  // Every one of the six, not just the first: a half-configured provider
  // fails at the moment someone tries to sign in with it.
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "ATLASSIAN_CLIENT_ID",
    "ATLASSIAN_CLIENT_SECRET",
  ] as const) {
    assert.throws(
      () => parseEnv({ ...required, [key]: "" }),
      new RegExp(key),
      `expected an empty ${key} to be rejected`,
    );
  }
});

test("parseEnv leaves AUTH_COOKIE_DOMAIN unset by default", () => {
  // Unset is correct for same-origin local dev: a Domain attribute on
  // localhost stops the session cookie working entirely.
  assert.equal(parseEnv(required).AUTH_COOKIE_DOMAIN, undefined);
});

test("parseEnv keeps AUTH_COOKIE_DOMAIN when set", () => {
  assert.equal(
    parseEnv({ ...required, AUTH_COOKIE_DOMAIN: ".lunox.work" })
      .AUTH_COOKIE_DOMAIN,
    ".lunox.work",
  );
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
