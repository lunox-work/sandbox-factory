/**
 * Tests for the build-provenance contract.
 *
 * The behaviour worth pinning down here is what happens at the edges: an
 * unidentified build, a dirty tree, and two surfaces that disagree. Those are
 * the cases that reach a user — a clean tagged release formats itself the
 * obvious way and needs little defending.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UNKNOWN_BUILD,
  buildBanner,
  buildInfoSchema,
  commitUrl,
  formatVersion,
  isIdentified,
  releaseTag,
  releaseUrl,
  sameBuild,
  unknownBuildInfo,
  verifyCommand,
  type BuildInfoDto,
} from "../src/build-info.js";

const identified: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

test("buildInfoSchema accepts a well-formed record", () => {
  assert.deepEqual(buildInfoSchema.parse(identified), identified);
});

test("buildInfoSchema rejects an empty sha", () => {
  assert.equal(
    buildInfoSchema.safeParse({ ...identified, gitSha: "" }).success,
    false,
  );
});

test("buildInfoSchema rejects a non-boolean dirty flag", () => {
  assert.equal(
    buildInfoSchema.safeParse({ ...identified, dirty: "yes" }).success,
    false,
  );
});

test("buildInfoSchema accepts the unknown fallback", () => {
  assert.deepEqual(buildInfoSchema.parse(unknownBuildInfo), unknownBuildInfo);
});

test("formatVersion joins version and short sha with semver build metadata", () => {
  assert.equal(formatVersion(identified), "1.4.2+7f3a9c1");
});

test("formatVersion marks a dirty tree", () => {
  assert.equal(
    formatVersion({ ...identified, dirty: true }),
    "1.4.2+7f3a9c1-dirty",
  );
});

// `1.4.2+unknown` would read as a commit named "unknown" rather than as an
// absent one, so the sha is dropped entirely instead.
test("formatVersion omits an unknown sha rather than printing it", () => {
  assert.equal(formatVersion(unknownBuildInfo), "0.0.0");
});

test("formatVersion still marks dirty on an unidentified build", () => {
  assert.equal(
    formatVersion({ ...unknownBuildInfo, dirty: true }),
    "0.0.0-dirty",
  );
});

test("isIdentified distinguishes a real build from the fallback", () => {
  assert.equal(isIdentified(identified), true);
  assert.equal(isIdentified(unknownBuildInfo), false);
});

test("commitUrl points at the full sha on the org repository", () => {
  assert.equal(
    commitUrl(identified),
    `https://github.com/lunox-work/sandbox-factory/commit/${identified.gitSha}`,
  );
});

// A link to /commit/unknown 404s; offering nothing is better than offering that.
test("commitUrl is undefined when the build is unidentified", () => {
  assert.equal(commitUrl(unknownBuildInfo), undefined);
});

// The prefix is not cosmetic: release.yml matched `v*` and therefore never
// fired for a single release-please tag. Pinned here so the two cannot drift
// apart again silently.
test("releaseTag carries the component prefix release-please uses", () => {
  assert.equal(releaseTag("1.0.0"), "sandbox-factory-v1.0.0");
});

test("releaseUrl points at the release page for a build of that tag", () => {
  const released: BuildInfoDto = {
    ...identified,
    version: "1.0.0",
    gitRef: "sandbox-factory-v1.0.0",
  };
  assert.equal(
    releaseUrl(released),
    "https://github.com/lunox-work/sandbox-factory/releases/tag/sandbox-factory-v1.0.0",
  );
});

// The case that makes this narrower than commitUrl. A commit after a release
// carries that release's version while not being it, and linking it to that
// release page would claim it shipped when it did not.
test("releaseUrl is undefined for a build that is not the tagged release", () => {
  assert.equal(releaseUrl({ ...identified, version: "1.0.0" }), undefined);
  assert.equal(releaseUrl(unknownBuildInfo), undefined);
});

test("verifyCommand takes the digest, which needs no registry access", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const command = verifyCommand({ ...identified, imageDigest: digest });
  assert.ok(command?.includes(`--digest ${digest}`));
  assert.ok(command?.includes("--repo lunox-work/sandbox-factory"));
});

// Nothing to verify without a digest, and a command built from a sha would
// invite running a check that cannot pass.
test("verifyCommand is undefined when no digest was resolved", () => {
  assert.equal(verifyCommand(identified), undefined);
});

test("sameBuild compares the full sha", () => {
  assert.equal(sameBuild(identified, { ...identified }), true);
  assert.equal(
    sameBuild(identified, {
      ...identified,
      gitSha: "b2e881d3c7a9f4e6d8b0a2c5e7f9d1b3a5c7e9f0",
      gitShortSha: "b2e881d",
    }),
    false,
  );
});

// Two commits between releases share a version, so a version comparison would
// call these the same build. The sha is what actually distinguishes them.
test("sameBuild is driven by the sha, not the version", () => {
  assert.equal(
    sameBuild(identified, { ...identified, version: "9.9.9" }),
    true,
  );
});

// Otherwise every local `docker compose up` would show a mismatch warning.
test("sameBuild treats an unidentified side as unanswerable, not mismatched", () => {
  assert.equal(sameBuild(identified, unknownBuildInfo), true);
  assert.equal(sameBuild(unknownBuildInfo, identified), true);
});

test("buildBanner carries the full sha for pasting into a report", () => {
  const banner = buildBanner("api", identified);
  assert.match(banner, /^api 1\.4\.2\+7f3a9c1 · /);
  assert.ok(banner.includes(identified.gitSha));
  assert.ok(banner.includes(identified.buildTime));
});

test("buildBanner omits commit detail it does not have", () => {
  assert.equal(buildBanner("api", unknownBuildInfo), "api 0.0.0");
});

test("UNKNOWN_BUILD is what the fallback record reports", () => {
  assert.equal(unknownBuildInfo.gitSha, UNKNOWN_BUILD);
});
