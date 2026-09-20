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
