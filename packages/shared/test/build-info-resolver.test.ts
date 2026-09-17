/**
 * Tests for `scripts/build-info.mjs`, the resolver every build site shares.
 *
 * Tested from this workspace because the script sits outside every workspace —
 * `npm test` runs `turbo run test`, which only visits workspaces, so a test
 * here is the only one that runs in CI. It belongs with `build-info.ts`
 * anyway: that file defines the record's contract and this one produces it.
 *
 * The cases that matter are the precedence rules. Environment must beat git, or
 * a container build stamps itself with whatever the host repository happened to
 * be on; and an injected sha must never be reported dirty, or every released
 * version string carries `-dirty`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInfoSchema, isIdentified } from "../src/build-info.js";

/**
 * Imported by URL rather than by relative path.
 *
 * Tests run from compiled output in `dist-test/test/`, which is one directory
 * deeper than the source they were written in, so a relative specifier that
 * looks right here resolves one level short at runtime. Building the URL from
 * this module's own location is depth-independent and survives the compile.
 */
const {
  isIdentified: resolverIsIdentified,
  resolveBuildInfo,
  toEnvLines,
} = (await import(
  new URL("../../../../scripts/build-info.mjs", import.meta.url).href
)) as typeof import("../../../scripts/build-info.mjs");

const SHA = "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09";

/**
 * A fully specified environment, so a test that is about one variable does not
 * silently depend on the checkout's real git state.
 */
const injected = {
  BUILD_VERSION: "1.4.2",
  BUILD_SHA: SHA,
  BUILD_TIME: "2026-09-17T09:14:00.000Z",
  BUILD_REF: "main",
};

// The whole point of the shared schema is that what the resolver produces is
// what the API and the browser can parse. If this drifts, everything else does.
test("the resolver's output satisfies the shared schema", () => {
  assert.doesNotThrow(() => buildInfoSchema.parse(resolveBuildInfo(injected)));
  // Also for a resolution that had to fall back, which is a different shape of
  // record and just as much a thing the API will serve.
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

// A container build has no .git to inspect; the injected value is the only
// truth available, and reading the host repository would be worse than nothing.
test("BUILD_SHA beats whatever the local repository says", () => {
  assert.equal(resolveBuildInfo({ BUILD_SHA: SHA }).gitSha, SHA);
});

test("GITHUB_SHA is used when BUILD_SHA is absent", () => {
  assert.equal(resolveBuildInfo({ GITHUB_SHA: SHA }).gitSha, SHA);
});

// BUILD_SHA is the generic escape hatch and has to be able to override Actions'
// own value, not merely fill in for it.
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

// Only a working tree can be dirty. Were this not so, every artifact built from
// an injected sha would carry `-dirty` in its version string.
test("an injected sha is never reported dirty", () => {
  assert.equal(resolveBuildInfo({ BUILD_SHA: SHA }).dirty, false);
  assert.equal(resolveBuildInfo({ GITHUB_SHA: SHA }).dirty, false);
});

test("an unset version falls back to the released package version", () => {
  // Read from packages/core/package.json — kept in step with the root —
  // rather than from an app, whose version is a permanent 0.0.0.
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
  // What a later workflow step reads back must be what the first step resolved,
  // or the artifact and the attestation describe different builds.
  assert.deepEqual(resolveBuildInfo(env), original);
});

/**
 * Empty is absent.
 *
 * Docker sets an undeclared `ARG` to the empty string rather than leaving it
 * unset, so `env.BUILD_TIME` is `""` for any build arg the caller omitted. A
 * plain `??` chain accepts that as an answer and skips the fallback — which
 * produced an image reporting an empty build time, found by building the web
 * image and reading the record back out of it.
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
  // The one that was actually set still comes through.
  assert.equal(info.gitSha, SHA);
});

test("an empty sha does not count as an identified build", () => {
  const info = resolveBuildInfo({ BUILD_SHA: "", GITHUB_SHA: "" });
  // Falls through to git, which in this checkout answers — so the assertion is
  // about the empty strings not being adopted, not about the fallback's value.
  assert.notEqual(info.gitSha, "");
  assert.notEqual(info.gitShortSha, "");
});

/**
 * A repository that cannot be read is worth saying out loud.
 *
 * Falling back is right in a container, which has no repository; it is
 * misleading when one is sitting right there, because the record comes out
 * plausible but empty and the only symptom is a version string that quietly
 * loses its sha. The usual cause is a shell whose PATH has no git — an
 * editor-launched dev server, typically.
 *
 * Asserted through the resolver's real output rather than by capturing the
 * warning, because what matters is that an injected sha stays silent: this
 * repo's own test run has a .git, so a warning on every call would be noise.
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
 * An explicit dirty flag overrides the injected-sha rule.
 *
 * The dev containers mount the repo but run `node:22-alpine`, which has no git
 * binary — so the host resolves the flag and passes it in alongside the sha.
 * Without this precedence the injected sha would force `dirty: false` and a
 * container serving a modified working tree would claim to be clean, which is
 * the one thing the flag exists to prevent.
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

// Empty is absent here too: compose substitutes an unset variable as "", and
// that must fall through to the normal rules rather than reading as false.
test("an empty BUILD_DIRTY falls through to the injected-sha rule", () => {
  assert.equal(
    resolveBuildInfo({ BUILD_SHA: SHA, BUILD_DIRTY: "" }).dirty,
    false,
  );
});
