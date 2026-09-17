/**
 * Tests for `scripts/build-info.mjs`, the resolver every build site shares.
 *
 * Lives here because the script sits outside every workspace and
 * `turbo run test` only visits workspaces, so this is the only place it runs
 * in CI.
 *
 * The precedence rules are what matter: environment beats git, and an injected
 * sha is never dirty.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInfoSchema, isIdentified } from "../src/build-info.js";

/**
 * Imported by URL: tests run from `dist-test/test/`, one directory deeper than
 * this source, so a relative specifier resolves one level short at runtime.
 */
const {
  isIdentified: resolverIsIdentified,
  resolveBuildInfo,
  toEnvLines,
} = (await import(
  new URL("../../../../scripts/build-info.mjs", import.meta.url).href
)) as typeof import("../../../scripts/build-info.mjs");

const SHA = "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09";

/** Fully specified, so no test depends on the checkout's real git state. */
const injected = {
  BUILD_VERSION: "1.4.2",
  BUILD_SHA: SHA,
  BUILD_TIME: "2026-09-17T09:14:00.000Z",
  BUILD_REF: "main",
};

// What the resolver produces must be what the API and the browser can parse.
test("the resolver's output satisfies the shared schema", () => {
  assert.doesNotThrow(() => buildInfoSchema.parse(resolveBuildInfo(injected)));
  // A fallback resolution is served too.
  assert.doesNotThrow(() => buildInfoSchema.parse(resolveBuildInfo({})));
});

test("explicit BUILD_ vars are used verbatim", () => {
  assert.deepEqual(resolveBuildInfo(injected), {
    version: "1.4.2",
    gitSha: SHA,
    gitShortSha: "7f3a9c1",
    buildTime: "2026-09-17T09:14:00.000Z",
    gitRef: "main",
    dirty: false,
  });
});

test("the short sha is the first seven of the full one", () => {
  assert.equal(resolveBuildInfo(injected).gitShortSha, SHA.slice(0, 7));
});

// A container build has no .git; the injected value is the only truth.
test("BUILD_SHA beats whatever the local repository says", () => {
  assert.equal(resolveBuildInfo({ BUILD_SHA: SHA }).gitSha, SHA);
});

test("GITHUB_SHA is used when BUILD_SHA is absent", () => {
  assert.equal(resolveBuildInfo({ GITHUB_SHA: SHA }).gitSha, SHA);
});

// BUILD_SHA must override Actions' own value, not merely fill in for it.
test("BUILD_SHA wins over GITHUB_SHA", () => {
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, GITHUB_SHA: "other" }).gitSha,
    SHA,
  );
});

test("GITHUB_REF_NAME supplies the ref in CI", () => {
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, GITHUB_REF_NAME: "v1.4.2" }).gitRef,
    "v1.4.2",
  );
});

// Only a working tree can be dirty; otherwise every artifact built from an
// injected sha would carry `-dirty`.
test("an injected sha is never reported dirty", () => {
  assert.equal(resolveBuildInfo({ BUILD_SHA: SHA }).dirty, false);
  assert.equal(resolveBuildInfo({ GITHUB_SHA: SHA }).dirty, false);
});

test("an unset version falls back to the released package version", () => {
  // Read from packages/core/package.json; an app's version is a permanent
  // 0.0.0.
  assert.match(resolveBuildInfo({ BUILD_SHA: SHA }).version, /^\d+\.\d+\.\d+/);
});

test("isIdentified agrees with the shared implementation", () => {
  const info = resolveBuildInfo(injected);
  assert.equal(resolverIsIdentified(info), true);
  assert.equal(isIdentified(info), true);
});

test("toEnvLines round-trips into a resolvable environment", () => {
  const original = resolveBuildInfo(injected);
  const env = Object.fromEntries(
    toEnvLines(original)
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  // Otherwise the artifact and the attestation describe different builds.
  assert.deepEqual(resolveBuildInfo(env), original);
});

/**
 * Empty is absent. Docker passes an omitted build arg as `""`, which a plain
 * `??` chain accepts, skipping the fallback — that once produced an image with
 * an empty build time.
 */
test("an empty variable falls back rather than being taken literally", () => {
  const info = resolveBuildInfo({
    BUILD_SHA: SHA,
    BUILD_TIME: "",
    BUILD_VERSION: "",
    BUILD_REF: "",
  });
  assert.notEqual(info.buildTime, "");
  assert.notEqual(info.version, "");
  assert.notEqual(info.gitRef, "");
  assert.equal(info.gitSha, SHA);
});

test("an empty sha does not count as an identified build", () => {
  const info = resolveBuildInfo({ BUILD_SHA: "", GITHUB_SHA: "" });
  // Falls through to git, so assert only that the empty strings are not
  // adopted, not what the fallback returns.
  assert.notEqual(info.gitSha, "");
  assert.notEqual(info.gitShortSha, "");
});

/**
 * The resolver warns when a repository is present but unreadable (usually a
 * PATH with no git), since the version otherwise quietly loses its sha. An
 * injected sha must stay silent, or every call in this checkout would warn.
 */
test("an injected sha does not warn even inside a repository", () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    resolveBuildInfo({ BUILD_SHA: SHA });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, []);
});

/**
 * The dev containers mount the repo but have no git binary, so the host
 * resolves the flag and passes it with the sha. Without this precedence a
 * container serving a modified tree would claim to be clean.
 */
test("BUILD_DIRTY wins over the injected-sha rule", () => {
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, BUILD_DIRTY: "true" }).dirty,
    true,
  );
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, BUILD_DIRTY: "false" }).dirty,
    false,
  );
});

// Empty is absent here too: compose substitutes an unset variable as "".
test("an empty BUILD_DIRTY falls through to the injected-sha rule", () => {
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, BUILD_DIRTY: "" }).dirty,
    false,
  );
});
