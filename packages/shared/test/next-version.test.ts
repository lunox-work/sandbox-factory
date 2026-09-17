/**
 * Tests for `scripts/next-version.mjs`, which decides the version CD tags a
 * deploy with.
 *
 * This runs unattended on every merge to main, and nobody reviews its answer
 * before it becomes a permanent tag — so the rule it encodes is pinned here
 * rather than trusted. A wrong bump is not self-correcting: the tag is public,
 * and the next release computes from it.
 *
 * Imported through a URL built from this module's own location, for the reason
 * `build-info-resolver.test.ts` documents at length — the compiled test sits at
 * a different depth than the source.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { parseSubject, bumpFor, applyBump } = (await import(
  new URL("../../../../scripts/next-version.mjs", import.meta.url).href
)) as typeof import("../../../scripts/next-version.mjs");

// --- parseSubject -----------------------------------------------------------

test("parses a plain conventional subject", () => {
  assert.deepEqual(parseSubject("fix: reject blank titles"), {
    type: "fix",
    breaking: false,
    subject: "reject blank titles",
  });
});

test("parses a scope", () => {
  const parsed = parseSubject("feat(api): add /version");
  assert.equal(parsed?.type, "feat");
  assert.equal(parsed?.breaking, false);
});

test("parses a breaking marker, with and without a scope", () => {
  assert.equal(parseSubject("feat!: drop node 20")?.breaking, true);
  assert.equal(parseSubject("feat(api)!: drop node 20")?.breaking, true);
});

// A non-conventional subject is not an error — ship.sh rejects those at the PR
// title, but a merge can still arrive by other routes, and one unparseable
// commit must not abort a release that other commits justify.
test("returns null for a subject that is not conventional", () => {
  assert.equal(parseSubject("update stuff"), null);
  assert.equal(parseSubject("Merge branch 'main'"), null);
});

// --- bumpFor ----------------------------------------------------------------

test("a feat is a minor", () => {
  assert.equal(bumpFor([{ subject: "feat: add a thing" }]), "minor");
});

test("a fix is a patch", () => {
  assert.equal(bumpFor([{ subject: "fix: fix a thing" }]), "patch");
});

test("a breaking change is a major, whatever its type", () => {
  assert.equal(bumpFor([{ subject: "fix!: change the contract" }]), "major");
  assert.equal(bumpFor([{ subject: "feat!: change the contract" }]), "major");
});

// The footer convention, which `!` does not always accompany.
test("a BREAKING CHANGE footer is a major", () => {
  assert.equal(
    bumpFor([
      { subject: "fix: something", body: "BREAKING CHANGE: the API moved" },
    ]),
    "major",
  );
});

// The bump is the highest any single commit calls for, not the last one seen.
test("the strongest bump in the range wins, regardless of order", () => {
  assert.equal(
    bumpFor([
      { subject: "fix: one" },
      { subject: "feat: two" },
      { subject: "fix: three" },
    ]),
    "minor",
  );
  assert.equal(
    bumpFor([
      { subject: "feat: one" },
      { subject: "fix!: two" },
      { subject: "feat: three" },
    ]),
    "major",
  );
});

// A docs-or-chore-only range is deliberately not releasable. Cutting a version
// for a README fix would make the number stop meaning anything, and CD reads
// null as "deploy, do not tag".
test("a range with nothing releasable yields null", () => {
  assert.equal(
    bumpFor([{ subject: "docs: tidy the readme" }, { subject: "chore: bump" }]),
    null,
  );
});

test("unparseable commits are skipped, not fatal", () => {
  assert.equal(
    bumpFor([
      { subject: "Merge branch 'main'" },
      { subject: "fix: real work" },
    ]),
    "patch",
  );
});

test("an empty range yields null", () => {
  assert.equal(bumpFor([]), null);
});

// --- applyBump --------------------------------------------------------------

test("applies each bump, zeroing the lower components", () => {
  assert.equal(applyBump("1.4.2", "major"), "2.0.0");
  assert.equal(applyBump("1.4.2", "minor"), "1.5.0");
  assert.equal(applyBump("1.4.2", "patch"), "1.4.3");
});

// The case this repository is actually in as this lands.
test("bumps 1.0.0 to 1.1.0 for a feat", () => {
  assert.equal(applyBump("1.0.0", "minor"), "1.1.0");
});

test("rejects a version it cannot parse rather than guessing", () => {
  assert.throws(() => applyBump("not-a-version", "patch"), /not a semver/);
});
