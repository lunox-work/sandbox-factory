import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { envKeys } from "../src/env.js";

/**
 * The signed image proves which code is running; it says nothing about the
 * environment that code was started with. These tests keep that gap small and
 * reviewable: the API reads a fixed list of variables, through one module, and
 * none of them changes what is collected, logged or stored.
 *
 * If one of these fails, you are widening what an operator can change without
 * touching the audited image. That can be fine — update the list here and the
 * table in docs/versioning.md ("What the environment can change") together.
 */

/** Compiled to dist-test/test/, so the repository root is four levels up. */
const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("the API reads exactly the documented environment variables", () => {
  assert.deepEqual(
    [...envKeys].sort(),
    [
      // Where it listens and who may call it.
      "PORT",
      "CORS_ORIGINS",
      "ORIGIN_VERIFY",
      // Where data is stored. The operator can already read the database, so
      // pointing at another one reveals nothing new.
      "DATABASE_URL",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_REGION",
      // Sign-in.
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "APP_URL",
      "AUTH_COOKIE_DOMAIN",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "ATLASSIAN_CLIENT_ID",
      "ATLASSIAN_CLIENT_SECRET",
      // The second Atlassian app, for connecting a client's Jira site.
      "JIRA_CLIENT_ID",
      "JIRA_CLIENT_SECRET",
      // Encrypts the stored Jira tokens. Unlike the values above it is not a
      // credential for another service: it is the only thing standing between
      // a leaked `jira_connection` row and a live grant on a client's Jira.
      "TOKEN_ENCRYPTION_KEY",
      // Reporting only.
      "BUILD_VERSION",
      "BUILD_SHA",
      "BUILD_TIME",
      "BUILD_REF",
      "BUILD_DIRTY",
    ].sort(),
  );
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("nothing the server runs reads process.env behind env.ts's back", () => {
  // env.ts: the schema's default source. image-digest.ts: the metadata URI the
  // ECS agent injects. migrate-cli.ts: a separate one-off process.
  const allowed = new Set([
    "apps/api/src/env.ts",
    "apps/api/src/image-digest.ts",
    "packages/db/src/migrate-cli.ts",
  ]);

  const offenders = [
    "apps/api/src",
    "packages/core/src",
    "packages/db/src",
    "packages/shared/src",
  ]
    .flatMap((dir) => sourceFiles(join(root, dir)))
    .filter((file) =>
      /process\s*\.\s*env/.test(stripComments(readFileSync(file, "utf8"))),
    )
    .map((file) => relative(root, file))
    .filter((file) => !allowed.has(file));

  assert.deepEqual(offenders, []);
});

/** Good enough for this: a mention of process.env in prose is not a read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Four files list the secrets that reach production, and nothing but a comment
 * keeps them in step:
 *
 *   infra/secrets.tf              creates them in AWS Secrets Manager
 *   infra/scripts/secrets-push.sh writes values to them
 *   scripts/rotate-token.sh       rotates one or all of them
 *   apps/api/src/env.ts           reads them
 *
 * Drift is silent and asymmetric, which is what makes it worth a test. A key
 * missing from `secrets-push.sh` is never pushed, so the task boots with the
 * placeholder. One missing from `rotate-token.sh` cannot be rotated and
 * `--only KEY` rejects it as unknown. Neither fails anything until the moment
 * it matters.
 *
 * **These read files outside this workspace, which turbo does not hash.** An
 * edit to `infra/` alone therefore replays a cached pass locally; CI starts
 * cold so it runs for real. If you change one of those files and want the
 * check now, `npx turbo run test --filter=@sandbox-factory/api --force`.
 */
function bashArray(file: string, name: string): string[] {
  const source = readFileSync(join(root, file), "utf8");
  // Anchored to the start of a line: `secrets-push.sh` declares `ONLY_KEYS=()`
  // above `KEYS=(`, and an unanchored search for `KEYS=(` finds that empty one
  // first and silently reports no keys at all.
  const match = new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(source);
  assert.ok(match, `${file}: no ${name}=( ... ) array`);
  return (match[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

test("every file that lists the production secrets lists the same ones", () => {
  const terraform = [
    ...readFileSync(join(root, "infra/secrets.tf"), "utf8").matchAll(
      /^\s{4}([A-Z][A-Z0-9_]*)\s*=/gm,
    ),
  ].map((match) => match[1] ?? "");

  const push = bashArray("infra/scripts/secrets-push.sh", "KEYS");
  const rotate = bashArray("scripts/rotate-token.sh", "SECRET_KEYS");

  assert.ok(
    terraform.length >= 8,
    `parsed ${terraform.length} from secrets.tf`,
  );
  assert.deepEqual([...push].sort(), [...terraform].sort());
  assert.deepEqual([...rotate].sort(), [...terraform].sort());

  // And each one is a variable the API actually reads, so a secret cannot be
  // created, pushed and rotated while the process ignores it.
  for (const key of terraform) {
    assert.ok(envKeys.includes(key), `${key} is pushed but never read`);
  }
});

test("rotate-token can rotate each secret individually", () => {
  // `--only KEY` validates against SECRET_KEYS, so a key absent from that
  // array is rejected as unknown — the failure mode is "I cannot rotate this
  // credential", discovered while trying to rotate a leaked one.
  const rotate = bashArray("scripts/rotate-token.sh", "SECRET_KEYS");

  for (const key of ["TOKEN_ENCRYPTION_KEY", "JIRA_CLIENT_SECRET"]) {
    assert.ok(rotate.includes(key), `--only ${key} would be rejected`);
  }
});

/**
 * Every `@sandbox-factory/*` package the API imports is declared as a
 * dependency of this workspace.
 *
 * npm hoists workspace packages into the root `node_modules`, so an undeclared
 * one resolves perfectly well on a developer's machine and fails only in CI,
 * where the install is clean — TS2307, from a file the change never touched.
 * It also makes the build order wrong: turbo's `dependsOn: ["^build"]` walks
 * *declared* dependencies, so an undeclared package's declarations may not
 * exist when this workspace type-checks.
 */
test("every workspace package the API imports is declared as a dependency", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "apps/api/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));

  const imported = new Set<string>();
  for (const file of sourceFiles(join(root, "apps/api/src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /from\s+"(@sandbox-factory\/[a-z-]+)"/g,
    )) {
      imported.add(match[1] ?? "");
    }
  }

  // Sanity: if this finds nothing, the regex has drifted and the test is
  // vacuous rather than passing.
  assert.ok(imported.size >= 2, `only found ${imported.size} imports`);

  for (const name of imported) {
    assert.ok(
      declared.has(name),
      `apps/api imports ${name} but does not declare it — it will fail a clean install`,
    );
  }
});
