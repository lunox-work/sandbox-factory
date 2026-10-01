import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  buildInfo,
  deepseekSizingConfig,
  GITHUB_APP_KEYS,
  githubAppConfig,
  githubAppMissing,
  jiraOAuthConfig,
  objectStoreConfig,
  parseEnv,
  sizingAvailable,
  sizingConfig,
} from "../src/env.js";

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
  // Object storage is off until a bucket is named.
  assert.equal(env.S3_BUCKET, undefined);
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

test("objectStoreConfig is undefined without a bucket, whatever else is set", () => {
  for (const partial of [
    { S3_ENDPOINT: "http://localhost:8333" },
    {
      S3_ENDPOINT: "http://localhost:8333",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    },
    // Compose passes an unset variable as "", which is not a bucket.
    { S3_BUCKET: "" },
  ]) {
    assert.equal(
      objectStoreConfig(parseEnv({ ...required, ...partial })),
      undefined,
    );
  }
});

test("objectStoreConfig with a bucket alone targets AWS with the default chain", () => {
  assert.deepEqual(
    objectStoreConfig(parseEnv({ ...required, S3_BUCKET: "avatars" })),
    { bucket: "avatars", region: "us-east-1" },
  );
});

test("objectStoreConfig returns the gateway config when S3 is fully configured", () => {
  assert.deepEqual(
    objectStoreConfig(
      parseEnv({
        ...required,
        S3_ENDPOINT: "http://localhost:8333",
        S3_BUCKET: "sandbox-factory",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    ),
    {
      endpoint: "http://localhost:8333",
      bucket: "sandbox-factory",
      credentials: { accessKeyId: "key", secretAccessKey: "secret" },
      region: "us-east-1",
    },
  );
});

test("parseEnv refuses half an S3 key pair with a readable message", () => {
  for (const partial of [
    { S3_ACCESS_KEY_ID: "key" },
    { S3_SECRET_ACCESS_KEY: "secret" },
  ]) {
    assert.throws(
      () => parseEnv({ ...required, S3_BUCKET: "b", ...partial }),
      /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together/,
    );
  }
});

test("parseEnv treats empty S3 keys as unset, as compose passes them", () => {
  const env = parseEnv({
    ...required,
    S3_BUCKET: "b",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
  });
  assert.equal(objectStoreConfig(env)?.credentials, undefined);
});

test("parseEnv rejects an S3_ENDPOINT that is not a URL", () => {
  assert.throws(
    () => parseEnv({ ...required, S3_ENDPOINT: "localhost:8333" }),
    /S3_ENDPOINT/,
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

test("the Jira connection credentials are optional", () => {
  // Unlike the sign-in pair: the sign-in screen offers Atlassian
  // unconditionally, so a missing value there is a button that fails at the
  // redirect. Connecting Jira is opt-in, and an API without it must still
  // serve every other route.
  assert.equal(parseEnv(required).JIRA_CLIENT_ID, undefined);
  assert.equal(jiraOAuthConfig(parseEnv(required)), undefined);
});

test("jiraOAuthConfig needs both halves", () => {
  // A half-configured pair would fail at the Atlassian redirect, which is a
  // worse place to find out than the route that refuses to start the flow.
  for (const partial of [
    { JIRA_CLIENT_ID: "jira-client-id" },
    { JIRA_CLIENT_SECRET: "jira-client-secret" },
  ]) {
    assert.equal(
      jiraOAuthConfig(parseEnv({ ...required, ...partial })),
      undefined,
    );
  }
});

test("jiraOAuthConfig returns the pair when both are set", () => {
  assert.deepEqual(
    jiraOAuthConfig(
      parseEnv({
        ...required,
        JIRA_CLIENT_ID: "jira-client-id",
        JIRA_CLIENT_SECRET: "jira-client-secret",
      }),
    ),
    { clientId: "jira-client-id", clientSecret: "jira-client-secret" },
  );
});

test("the Jira app credentials are distinct from the sign-in ones", () => {
  // The whole point of the split: one app's grant overwrites the other's
  // scopes, so sharing a client id would make sign-in and Jira connections
  // break each other.
  const env = parseEnv({
    ...required,
    JIRA_CLIENT_ID: "jira-client-id",
    JIRA_CLIENT_SECRET: "jira-client-secret",
  });

  assert.notEqual(env.JIRA_CLIENT_ID, env.ATLASSIAN_CLIENT_ID);
});

test("sizing remains unavailable until both provider values are configured", () => {
  assert.equal(sizingConfig(parseEnv(required)), undefined);
  assert.equal(
    sizingConfig(parseEnv({ ...required, ANTHROPIC_API_KEY: "key" })),
    undefined,
  );
  assert.equal(
    sizingConfig(parseEnv({ ...required, SIZING_MODEL: "configured-model" })),
    undefined,
  );
  assert.deepEqual(
    sizingConfig(
      parseEnv({
        ...required,
        ANTHROPIC_API_KEY: "key",
        SIZING_MODEL: "configured-model",
      }),
    ),
    { apiKey: "key", model: "configured-model" },
  );
});

test("empty sizing values behave as unset and do not stop boot", () => {
  const env = parseEnv({
    ...required,
    ANTHROPIC_API_KEY: "",
    SIZING_MODEL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_SIZING_MODEL: "",
    // docker-compose.yml passes `${DEEPSEEK_BASE_URL:-}`, so an unset override
    // arrives as "" rather than absent; it must not fail URL validation.
    DEEPSEEK_BASE_URL: "",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SIZING_MODEL, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_SIZING_MODEL, undefined);
  assert.equal(env.DEEPSEEK_BASE_URL, undefined);
});

test("the Terraform placeholder leaves a sizing pair unset", () => {
  // infra/secrets.tf seeds every secret with it; a pair never pushed must not
  // look configured and send the placeholder to a provider.
  const env = parseEnv({
    ...required,
    ANTHROPIC_API_KEY: "REPLACE_ME",
    SIZING_MODEL: "REPLACE_ME",
    DEEPSEEK_API_KEY: "REPLACE_ME",
    DEEPSEEK_SIZING_MODEL: "REPLACE_ME",
  });
  assert.equal(sizingConfig(env), undefined);
  assert.equal(deepseekSizingConfig(env), undefined);
  assert.equal(sizingAvailable(env), false);
});

test("the Terraform placeholder or an empty value leaves the Jira app unset", () => {
  // Unset, the connect route answers 501; a placeholder taken for a client id
  // would send the user to Atlassian's error page instead.
  for (const value of ["REPLACE_ME", ""]) {
    const env = parseEnv({
      ...required,
      JIRA_CLIENT_ID: value,
      JIRA_CLIENT_SECRET: value,
    });
    assert.equal(jiraOAuthConfig(env), undefined);
  }
});

test("the sizing fallback needs its own pair, and the base URL is optional", () => {
  assert.equal(deepseekSizingConfig(parseEnv(required)), undefined);
  assert.equal(
    deepseekSizingConfig(parseEnv({ ...required, DEEPSEEK_API_KEY: "key" })),
    undefined,
  );
  assert.deepEqual(
    deepseekSizingConfig(
      parseEnv({
        ...required,
        DEEPSEEK_API_KEY: "key",
        DEEPSEEK_SIZING_MODEL: "deepseek-model",
      }),
    ),
    { apiKey: "key", model: "deepseek-model" },
  );
  assert.deepEqual(
    deepseekSizingConfig(
      parseEnv({
        ...required,
        DEEPSEEK_API_KEY: "key",
        DEEPSEEK_SIZING_MODEL: "deepseek-model",
        DEEPSEEK_BASE_URL: "https://gateway.internal",
      }),
    ),
    {
      apiKey: "key",
      model: "deepseek-model",
      baseUrl: "https://gateway.internal",
    },
  );
});

test("either provider pair on its own makes sizing available", () => {
  assert.equal(sizingAvailable(parseEnv(required)), false);
  // A DeepSeek-only deploy is a configured deploy: the executor mounts on
  // this, not on the Anthropic pair.
  assert.equal(
    sizingAvailable(
      parseEnv({
        ...required,
        DEEPSEEK_API_KEY: "key",
        DEEPSEEK_SIZING_MODEL: "deepseek-model",
      }),
    ),
    true,
  );
  assert.equal(
    sizingAvailable(
      parseEnv({
        ...required,
        ANTHROPIC_API_KEY: "key",
        SIZING_MODEL: "configured-model",
      }),
    ),
    true,
  );
});

/** A real RSA key, as base64 of the PEM: how the App's key is stored. */
const appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const githubApp = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "sandbox-factory",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(appKeyPem).toString("base64"),
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.app",
  GITHUB_APP_CLIENT_SECRET: "app-secret",
};

test("the GitHub App is optional, and off unless all six values are set", () => {
  assert.equal(githubAppConfig(parseEnv(required)), undefined);
  for (const key of Object.keys(githubApp)) {
    const partial: Record<string, string> = { ...githubApp };
    delete partial[key];
    assert.equal(
      githubAppConfig(parseEnv({ ...required, ...partial })),
      undefined,
      `configured without ${key}`,
    );
  }
});

test("a partly set App names what is missing; none or all names nothing", () => {
  // Off either way, but a partial set reads as "configured" to whoever set
  // it, so boot says which values are absent.
  const partial: Record<string, string> = { ...githubApp };
  delete partial["GITHUB_APP_WEBHOOK_SECRET"];
  delete partial["GITHUB_APP_CLIENT_SECRET"];

  assert.deepEqual(githubAppMissing(parseEnv({ ...required, ...partial })), [
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_APP_CLIENT_SECRET",
  ]);
  assert.deepEqual(githubAppMissing(parseEnv(required)), []);
  assert.deepEqual(
    githubAppMissing(parseEnv({ ...required, ...githubApp })),
    [],
  );
  assert.deepEqual([...GITHUB_APP_KEYS].sort(), Object.keys(githubApp).sort());
});

test("a PEM pasted with its newlines escaped boots", () => {
  const escaped = appKeyPem.trimEnd().split("\n").join("\\n");

  const config = githubAppConfig(
    parseEnv({ ...required, ...githubApp, GITHUB_APP_PRIVATE_KEY: escaped }),
  );

  assert.equal(config?.privateKey.asymmetricKeyType, "rsa");
});

test("the GitHub App config reads the key from base64 or from the PEM", () => {
  const fromBase64 = githubAppConfig(parseEnv({ ...required, ...githubApp }));
  const fromPem = githubAppConfig(
    parseEnv({ ...required, ...githubApp, GITHUB_APP_PRIVATE_KEY: appKeyPem }),
  );

  assert.equal(fromBase64?.appId, "123456");
  assert.equal(fromBase64?.slug, "sandbox-factory");
  assert.equal(fromBase64?.privateKey.asymmetricKeyType, "rsa");
  assert.equal(fromPem?.privateKey.asymmetricKeyType, "rsa");
  // Distinct from the sign-in pair, which is a different OAuth app.
  assert.notEqual(fromBase64?.clientId, required.GITHUB_CLIENT_ID);
});

test("an unreadable App key fails at boot, without echoing the value", () => {
  assert.throws(
    () =>
      parseEnv({
        ...required,
        ...githubApp,
        GITHUB_APP_PRIVATE_KEY: "bm90LWEta2V5",
      }),
    (error: Error) =>
      /GITHUB_APP_PRIVATE_KEY/.test(error.message) &&
      !error.message.includes("bm90LWEta2V5"),
  );
});

test("a non-numeric App id is refused", () => {
  assert.throws(
    () => parseEnv({ ...required, ...githubApp, GITHUB_APP_ID: "sandbox" }),
    /GITHUB_APP_ID must be numeric/,
  );
});

test("the Terraform placeholder leaves the GitHub App unset", () => {
  const placeholders = Object.fromEntries(
    Object.keys(githubApp).map((key) => [key, "REPLACE_ME"]),
  );

  assert.equal(
    githubAppConfig(parseEnv({ ...required, ...placeholders })),
    undefined,
  );
});
