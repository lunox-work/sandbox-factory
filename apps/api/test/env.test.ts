import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInfo, objectStoreConfig, parseEnv } from "../src/env.js";

const DATABASE_URL = "postgres://postgres:postgres@localhost:5432/test";
/** Exactly the 32-character minimum. */
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every required var, so each test reads as being about the field it sets. */
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
  // Must decode to exactly 32 bytes; see the TOKEN_ENCRYPTION_KEY tests below.
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
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
  // There is no in-memory fallback, so this must fail at boot.
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
  // A short secret works fine in dev and is a real weakness in production.
  assert.throws(
    () => parseEnv({ ...required, BETTER_AUTH_SECRET: "too-short" }),
    /BETTER_AUTH_SECRET/,
  );
});

test("parseEnv rejects a BETTER_AUTH_URL that is not absolute", () => {
  // Provider callback URLs are built from this; a relative value would only
  // surface as a redirect_uri mismatch at the provider.
  assert.throws(
    () => parseEnv({ ...required, BETTER_AUTH_URL: "/api/auth" }),
    /BETTER_AUTH_URL/,
  );
});

test("parseEnv requires each OAuth credential", () => {
  // All six: a half-configured provider fails only when someone signs in.
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

test("TOKEN_ENCRYPTION_KEY is required", () => {
  // Required rather than optional on purpose: an API that boots without it
  // would write Jira tokens the cipher cannot protect, and nothing downstream
  // would notice until a row leaked.
  const { TOKEN_ENCRYPTION_KEY: _omitted, ...withoutKey } = required;

  assert.throws(() => parseEnv(withoutKey), /TOKEN_ENCRYPTION_KEY/);
});

test("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes", () => {
  // A 31-byte key is base64 of almost the same length as a 32-byte one, so
  // this catches the typo that a length check on the string would not.
  for (const bytes of [16, 31, 33]) {
    assert.throws(
      () =>
        parseEnv({
          ...required,
          TOKEN_ENCRYPTION_KEY: Buffer.alloc(bytes, 1).toString("base64"),
        }),
      /TOKEN_ENCRYPTION_KEY/,
      `expected a ${bytes}-byte key to be rejected`,
    );
  }

  // And the right length is accepted.
  assert.equal(
    parseEnv({
      ...required,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    }).TOKEN_ENCRYPTION_KEY,
    Buffer.alloc(32, 9).toString("base64"),
  );
});

test("parseEnv leaves AUTH_COOKIE_DOMAIN unset by default", () => {
  // A Domain attribute on localhost breaks the session cookie.
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

/**
 * Build provenance. An unset build var degrades the report but never fails
 * boot; the release workflow guards against an unidentified release.
 */
test("parseEnv accepts an environment with no build vars at all", () => {
  const env = parseEnv(required);
  assert.equal(env.BUILD_SHA, undefined);
  assert.equal(env.BUILD_DIRTY, false);
});

test("buildInfo reports the unknown record when nothing is injected", () => {
  assert.deepEqual(buildInfo(parseEnv(required)), {
    version: "0.0.0",
    gitSha: "unknown",
    gitShortSha: "unknown",
    buildTime: "unknown",
    gitRef: "unknown",
    dirty: false,
  });
});

test("buildInfo reads an injected build", () => {
  const env = parseEnv({
    ...required,
    BUILD_VERSION: "1.4.2",
    BUILD_SHA: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
    BUILD_TIME: "2026-09-17T09:14:00.000Z",
    BUILD_REF: "main",
  });
  assert.deepEqual(buildInfo(env), {
    version: "1.4.2",
    gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
    gitShortSha: "7f3a9c1",
    buildTime: "2026-09-17T09:14:00.000Z",
    gitRef: "main",
    dirty: false,
  });
});

// Derived, so it cannot disagree with the sha it abbreviates.
test("buildInfo derives the short sha from the full one", () => {
  const env = parseEnv({ ...required, BUILD_SHA: "abcdef1234567890" });
  assert.equal(buildInfo(env).gitShortSha, "abcdef1");
});

// A build with a sha but no timestamp must still report the sha.
test("buildInfo falls back per field, not as a whole record", () => {
  const info = buildInfo(parseEnv({ ...required, BUILD_SHA: "abcdef1234567" }));
  assert.equal(info.gitSha, "abcdef1234567");
  assert.equal(info.buildTime, "unknown");
  assert.equal(info.version, "0.0.0");
});

test("buildInfo reads the dirty flag as a boolean", () => {
  assert.equal(
    buildInfo(parseEnv({ ...required, BUILD_DIRTY: "true" })).dirty,
    true,
  );
  assert.equal(
    buildInfo(parseEnv({ ...required, BUILD_DIRTY: "false" })).dirty,
    false,
  );
});

test("parseEnv rejects a BUILD_DIRTY that is neither true nor false", () => {
  assert.throws(
    () => parseEnv({ ...required, BUILD_DIRTY: "yes" }),
    /BUILD_DIRTY/,
  );
});
