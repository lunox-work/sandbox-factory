import assert from "node:assert/strict";
import { test } from "node:test";
import {
  entropy,
  isSecretPath,
  scanSecrets,
  secretBlockers,
} from "../src/index.js";

// Tokens are assembled at run time so the repository holds none whole.
const join = (...parts: string[]) => parts.join("");
const RANDOM = "q7Rf2Lk9Zp3Wm8Xc4Vb6Nt1Hs5Jd0GyU";
const BASE64 =
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const ruleLines = (text: string, path = "f.ts") =>
  scanSecrets([{ path, text }]).map((f) => `${f.line}:${f.rule}`);

test("provider tokens are found by shape, on their line", () => {
  const text = [
    "const a = 1;",
    `const pem = "${join("-----BEGIN ", "RSA PRIVATE KEY-----")}\\n${BASE64}\\n";`,
    `aws = "${join("AKIA", "Z3K7Q2M9W4X8C6V1")}"`,
    `gh = "${join("ghp_", RANDOM, "abcd")}"`,
    `pat = "${join("github_", "pat_", RANDOM)}"`,
    `slack = "${join("xox", "b-", "1234567890-", RANDOM)}"`,
    `stripe = "${join("sk_", "live_", RANDOM)}"`,
    `google = "${join("AI", "za", RANDOM, "Ab3")}"`,
    `jwt = "${join("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", RANDOM)}"`,
    `anthropic = "${join("sk-", "ant-", RANDOM)}"`,
    `openai = "${join("sk-", "proj-", RANDOM)}"`,
    `legacy = "${join("sk-", RANDOM, RANDOM.slice(0, 16))}"`,
    `gitlab = "${join("gl", "pat-", RANDOM.slice(0, 20))}"`,
    `npm = "${join("npm", "_", RANDOM, "abcd")}"`,
    `sendgrid = "${join("SG", ".", RANDOM.slice(0, 22), ".", RANDOM, "abcdefghijk")}"`,
    `hf = "${join("hf", "_", RANDOM, "ab")}"`,
    `curl -H "Authorization: Bearer ${RANDOM}"`,
    `//registry.npmjs.org/:${join("_auth", "Token")}=${join("550e8400-e29b-", "41d4-a716-446655440000")}`,
    `${join("_auth", "=")}${BASE64}`,
  ].join("\n");
  assert.deepEqual(ruleLines(text), [
    "2:private-key",
    "3:aws-access-key-id",
    "4:github-token",
    "5:github-token",
    "6:slack-token",
    "7:stripe-live-key",
    "8:google-api-key",
    "9:jwt",
    "10:anthropic-key",
    "11:openai-key",
    "12:openai-key",
    "13:gitlab-token",
    "14:npm-token",
    "15:sendgrid-key",
    "16:huggingface-token",
    "17:bearer-token",
    "18:npm-token",
    "19:npm-token",
  ]);
});

test("a token or URL password is a placeholder only as a whole", () => {
  assert.deepEqual(
    ruleLines(
      [
        `stripe = "${join("sk_", "live_", "Test", RANDOM)}"`,
        `gh = "${join("ghp_", "TEST", RANDOM)}"`,
        `DATABASE_URL=postgres://app:${join("S3cr3t", "Test99")}@db/x`,
        `slack = "${join("xox", "b-", "mock-", RANDOM)}"`,
      ].join("\n"),
    ),
    [
      "1:stripe-live-key",
      "2:github-token",
      "3:url-credentials",
      "4:slack-token",
    ],
  );
  const text = [
    `stripe = "${join("sk_", "live_", "0".repeat(24))}"`,
    `stripe = "${join("sk_", "live_", "x".repeat(24))}"`,
    `hf = "${join("hf", "_", "X".repeat(34))}"`,
    `slack = "${join("xox", "b-", "*".repeat(12))}"`,
    "Authorization: Bearer <token>",
    `Authorization: Bearer ${"x0".repeat(12)}`,
    "Authorization: Bearer token_from_the_dashboard_v2",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    `//registry.npmjs.org/:${join("_auth", "Token")}=\${NPM_TOKEN}`,
    `${join("_auth", "Token")}=$NPM_TOKEN`,
    `this.${join("_auth", "Token")} = token;`,
    "postgres://app:changeme@db/x",
    "postgres://app:your-password-here@db/x",
    "postgres://app:xxxxxxxx@db/x",
  ].join("\n");
  assert.deepEqual(scanSecrets([{ path: "ok.ts", text }]), []);
});

test("a service-account JSON and a generic assignment are found", () => {
  const account = JSON.stringify(
    {
      type: "service_account",
      private_key: join("-----BEGIN ", "PRIVATE KEY-----\n", BASE64, "\n"),
      client_email: "robot@acme.example",
    },
    null,
    2,
  );
  assert.deepEqual(ruleLines(account, "sa.json"), [
    "3:private-key",
    "3:google-service-account",
  ]);
  assert.deepEqual(
    ruleLines(
      [
        `const apiKey = "${RANDOM}";`,
        `  "client_secret": '${RANDOM}',`,
        `DB_PASSWORD=${RANDOM}`,
        `  auth_token: ${RANDOM}`,
        `export const settings = { accessKey: \`${RANDOM}\` };`,
        `const apiKey: string = "${RANDOM}";`,
        `api_key: str = '${RANDOM}'`,
        `DB_PASSWORD=${RANDOM} # rotate quarterly`,
        `  auth_token: ${RANDOM}  # staging`,
        `const apiKey = process.env.API_KEY ?? "${RANDOM}";`,
        `const secret = env.APP_SECRET || '${RANDOM}';`,
        `const sharedSecret = "9c1e4b7a2f0d8e3c6a5b1f4d7e0c9a2b";`,
        `SECRET_KEY = "${RANDOM}"`,
        `SECRET_KEY_BASE=${RANDOM}`,
        `const signingKey = "Xk9-${RANDOM}";`,
        'password: "correcthorsebatterystaple",',
        "DB_PASSWORD=correcthorsebatterystaple",
      ].join("\n"),
    ),
    [
      "1:generic-secret",
      "2:generic-secret",
      "3:generic-secret",
      "4:generic-secret",
      "5:generic-secret",
      "6:generic-secret",
      "7:generic-secret",
      "8:generic-secret",
      "9:generic-secret",
      "10:generic-secret",
      "11:generic-secret",
      "12:generic-secret",
      "13:generic-secret",
      "14:generic-secret",
      "15:generic-secret",
      "16:generic-secret",
      "17:generic-secret",
    ],
  );
});

test("a name that goes on past its secret word, or a value that reads as a name, is not a secret", () => {
  const text = [
    'const tokenizerModel = "gpt-4o-mini-2024-07-18";',
    'const TOKEN_REFRESH_QUEUE = "token-refresh-queue-v2";',
    'const passwordResetPath = "/account/password/reset2";',
    'const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf";',
    'const tokenCount = "1234567890abcdef1234";',
    // A secret's name, but a path, an ARN, a model or a version for a value.
    "DB_PASSWORD_FILE=/run/secrets/db_password_2",
    'const apiKey = "arn:aws:secretsmanager:us-east-1:123456789012:secret:k9";',
    'const authToken = "claude-3-5-sonnet-20241022";',
    'const accessToken = "1.2.3-beta.4-build.5678";',
    'const secret = "./config/keys/primary-v2";',
    // Letters alone under a password's name: an identifier, or one letter.
    'password: "passwordInputField",',
    'const password = "aaaaaaaaaaaaaaaaaaaa";',
    'const secret = "correcthorsebatterystaple";',
  ].join("\n");
  assert.deepEqual(scanSecrets([{ path: "ok.ts", text }]), []);
});

test("a URL's password is found unless empty, a template or a placeholder", () => {
  assert.deepEqual(
    ruleLines(
      [
        `DATABASE_URL=postgres://admin:${join("S3cr3t", "Pass")}@db.internal:5432/app`,
        `const redis = "redis://:${join("q7Rf2", "Lk9Zp")}@cache:6379";`,
        "postgres://user:@localhost/app",
        "postgres://user:password@localhost/app",
        "postgres://postgres:postgres@localhost/app",
        "https://x-access-token:${GITHUB_TOKEN}@github.com/acme/app.git",
        "mysql://root:<password>@localhost/app",
        "amqp://guest:guest@rabbit:5672",
        "https://user:***@host/",
        "git+ssh://git@github.com:acme/app.git",
        "http://localhost:8080/@scope/pkg",
      ].join("\n"),
    ),
    ["1:url-credentials", "2:url-credentials"],
  );
});

test("a hex digest under a hash's name is not a secret", () => {
  const sha1 = "3f786850e387550fdab836ed7e6dc881de23001b";
  const sha256 = `${sha1}${"0a1b2c3d".repeat(3)}`;
  assert.deepEqual(
    ruleLines(
      [
        `const tokenHash = "${sha1}";`,
        `TOKEN_SHA256=${sha256}`,
        `"secretDigest": "sha256:${sha256}",`,
        `const passwordChecksum = '${sha1}';`,
        `const hashedPassword = "${sha1}";`,
      ].join("\n"),
    ),
    [],
  );
});

test("placeholders, env reads, words and short values are not secrets", () => {
  const text = [
    "const password = process.env.DB_PASSWORD;",
    'const token = "changeme";',
    'const apiKey = "<your-api-key-here-1234>";',
    'const secret = "${SECRET_VALUE_FROM_ENV_1}";',
    `const key = "${join("AKIA", "IOSFODNN7EXAMPLE")}";`,
    `gh = "${join("ghp_", "x".repeat(36))}"`,
    "API_SECRET=sandbox-fixture-api-secret",
    'const tokenizer = "word-piece-tokenizer";',
    'const password = "short1";',
    'const secretName = "orders-reader-role";',
    'const token = "aaaaaaaaaaaaaaaaaaaa1111";',
    'const token = "https://auth.acme.example/1234567890";',
    "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    '"private_key": "<redacted>", "client_email": "x"',
    `stripe = "${join("sk_", "test_", RANDOM)}"`,
  ].join("\n");
  assert.deepEqual(scanSecrets([{ path: "ok.ts", text }]), []);
  assert.deepEqual(scanSecrets([{ path: "empty.ts", text: "" }]), []);
  assert.equal(entropy(""), 0);
  assert.equal(entropy("aaaa"), 0);
  assert.equal(entropy("abcd"), 2);
});

test("findings name file, line and rule in order, and never the value", () => {
  const value = join("sk_", "live_", RANDOM);
  const findings = scanSecrets([
    { path: "b.ts", text: `x = "${value}"\n` },
    {
      path: "a.ts",
      text: `y = 1\nz = "${value}" + "${value}"\n${Array.from({ length: 6 }, () => `k = "${value}"`).join("\n")}`,
    },
  ]);
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line}`),
    [
      "a.ts:2",
      "a.ts:3",
      "a.ts:4",
      "a.ts:5",
      "a.ts:6",
      "a.ts:7",
      "a.ts:8",
      "b.ts:1",
    ],
  );
  const blockers = secretBlockers(findings);
  assert.deepEqual(blockers, [
    {
      code: "secret_found",
      file: "a.ts",
      detail:
        "A credential appears at a.ts:2 (stripe-live-key), a.ts:3 (stripe-live-key), a.ts:4 (stripe-live-key), a.ts:5 (stripe-live-key), a.ts:6 (stripe-live-key), and 2 more. Remove it or replace it with a fixture value.",
    },
    {
      code: "secret_found",
      file: "b.ts",
      detail:
        "A credential appears at b.ts:1 (stripe-live-key). Remove it or replace it with a fixture value.",
    },
  ]);
  assert.equal(JSON.stringify(blockers).includes(RANDOM), false);
  assert.deepEqual(secretBlockers([]), []);
});

test("credential files are recognized by name", () => {
  for (const path of [
    ".env",
    "config/.env.production",
    "certs/server.pem",
    "tls.KEY",
    "store.p12",
    "store.pfx",
    "home/id_rsa",
    "id_ed25519.pub",
    "gcp-credentials.json",
    "firebase-service-account-prod.json",
    "service_account.json",
    "acme-firebase-adminsdk-x1y2z.json",
    "credentials.json",
    "packages/app/.npmrc",
    "home/.ssh/id_ecdsa",
    "id_dsa",
    "deploy/.netrc",
    ".aws/credentials",
    "home/.AWS/credentials",
    "android/app/release.jks",
    "android/upload.keystore",
    "apps/api/.env.local",
    ".env-production",
    "deploy/prod.env",
    ".envrc",
    "config/secrets.yml",
    "secrets.json",
    "secrets.toml",
    "appsettings.secrets.yaml",
    "serviceAccountKey.json",
    "firebase-private-key-prod.json",
    "gcp-key.json",
    "home/.git-credentials",
    ".pgpass",
    ".pypirc",
    "infra/prod.tfvars",
    "infra/prod.auto.tfvars",
    "infra/terraform.tfvars.json",
    "home/.docker/config.json",
    ".docker/config.json",
    "AuthKey_ABC123.p8",
    "deploy.ppk",
    "kubeconfig",
    "deploy/kubeconfig-prod.yaml",
    "clusters/staging.kubeconfig",
    "home/.kube/config",
  ])
    assert.equal(isSecretPath(path), true, path);
  for (const path of [
    "src/env.ts",
    "environment.json",
    "src/keys.ts",
    "monkey.json",
    "docs/credentials.md",
    "src/firebase-adminsdk.ts",
    "data/prices.json",
    // Templates document keys, not values; their text is still scanned.
    ".env.example",
    "apps/api/.env.sample",
    ".env.template",
    ".env.local.example",
    ".env-example",
    "deploy/prod.env.sample",
    "infra/terraform.tfvars.example",
    // Needed configuration; its tokens are found by content, not name.
    ".yarnrc.yml",
    "credentials",
    "aws/credentials",
    "src/keystore.ts",
    "src/secrets.ts",
    "docs/secrets.md",
    "src/environment.ts",
    "src/kubeconfig.ts",
    "monkey.json",
    "docker/config.json",
    "kube/config",
    "src/.kube/config.ts",
  ])
    assert.equal(isSecretPath(path), false, path);
});
