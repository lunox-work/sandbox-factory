/**
 * Resolves what a build should say about where it came from.
 *
 * One source of truth for four build sites — Vite (web), esbuild (extension),
 * the API's Docker build, and CI. They must agree: the web app compares its own
 * sha against the API's, and two resolvers that disagreed about, say, short-sha
 * length would report a permanent mismatch between artifacts built from one
 * commit.
 *
 * Order is environment first, then git. CI knows the commit it checked out
 * exactly, including for a detached HEAD or a tag build, and a container build
 * has no .git directory at all — so an explicit value always wins over what the
 * local repository happens to say.
 *
 * Usage:
 *   node scripts/build-info.mjs            # prints JSON
 *   node scripts/build-info.mjs --env      # prints KEY=value for $GITHUB_ENV
 *   node scripts/build-info.mjs --require-identified   # exits 1 if unknown
 *
 *   import { resolveBuildInfo } from "./scripts/build-info.mjs";
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors `UNKNOWN_BUILD` in packages/shared; see the note in `resolveBuildInfo`. */
const UNKNOWN = "unknown";

/**
 * Runs a git command, or returns undefined when git cannot answer.
 *
 * A missing git, a missing .git directory and a failing command are all the
 * same outcome here: this build cannot learn its own provenance from the
 * repository, and must fall back rather than abort. A container build is the
 * normal case for that, not an error.
 */
function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The version the artifact reports.
 *
 * Read from `packages/core/package.json` because that is the workspace
 * CD bumps on release — its version is the one that gets tagged, changelogged
 * and published, so it is the number a release actually refers to. The apps are
 * all `0.0.0` and private; reading a version from one of those would report a
 * number that never changes.
 */
function packageVersion() {
  try {
    const manifest = readFileSync(
      join(REPO_ROOT, "packages/core/package.json"),
      "utf8",
    );
    return JSON.parse(manifest).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Whether the working tree has uncommitted changes.
 *
 * Only meaningful locally — CI checks out a clean tree — but it is the field
 * that explains an artifact behaving unlike its commit, so it is worth the
 * extra git call. `--porcelain` prints nothing for a clean tree.
 *
 * Undefined (git unavailable) is reported as clean rather than dirty: claiming
 * a container build is dirty because it has no .git would be false, and would
 * put `-dirty` on every released version string.
 */
function isDirty() {
  const status = git("status", "--porcelain");
  return status !== undefined && status !== "";
}

/**
 * Reads a variable, treating empty as absent.
 *
 * Docker sets an undeclared `ARG` to the empty string rather than leaving it
 * unset, so a plain `??` chain accepts `""` as a real answer and skips the
 * fallback — which is how a container build ends up reporting an empty
 * buildTime instead of "unknown". Every read below goes through this.
 */
function read(env, name) {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolves the build record.
 *
 * `env` is injectable so the tests can drive every branch without mutating
 * `process.env` around a real git repository.
 */
export function resolveBuildInfo(env = process.env) {
  // GITHUB_SHA is set by every GitHub Actions run. BUILD_SHA is the generic
  // escape hatch for a Docker build arg or another CI system, and is checked
  // first so it can override even inside Actions.
  const sha =
    read(env, "BUILD_SHA") ??
    read(env, "GITHUB_SHA") ??
    git("rev-parse", "HEAD");

  // `GITHUB_REF_NAME` is the branch or tag; on a pull_request event it is the
  // synthetic `<n>/merge` ref, which is accurate — that merge commit is
  // genuinely what was built, and is not the same tree as either side.
  const ref =
    read(env, "BUILD_REF") ??
    read(env, "GITHUB_REF_NAME") ??
    git("rev-parse", "--abbrev-ref", "HEAD");

  const version = read(env, "BUILD_VERSION") ?? packageVersion();

  // Resolved once here rather than at each use, so every artifact from a single
  // build carries the same timestamp instead of one per injection site.
  const buildTime = read(env, "BUILD_TIME") ?? new Date().toISOString();

  // Three cases, in order.
  //
  // An explicit BUILD_DIRTY wins: the dev containers mount the repo but run on
  // an image with no git binary, so the host resolves this and passes it in.
  // Without this branch the injected-sha case below would force it to false and
  // a container serving a modified tree would claim to be clean.
  //
  // Otherwise an injected sha means a build with no repository to inspect, so
  // it cannot be dirty — only a working tree can. Checking git there would be
  // wrong anyway, since an absent .git reads as clean.
  //
  // Otherwise ask git, which is the ordinary local build.
  const explicitDirty = read(env, "BUILD_DIRTY");
  const dirty =
    explicitDirty !== undefined
      ? explicitDirty === "true"
      : read(env, "BUILD_SHA") !== undefined ||
          read(env, "GITHUB_SHA") !== undefined
        ? false
        : isDirty();

  // Falling back is correct in a container, which has no repository to read,
  // and wrong-looking anywhere a repository is sitting right there: the record
  // comes out plausible but empty — "unknown", never dirty — and the only
  // symptom is a version string that quietly reads `0.0.0`.
  //
  // The usual cause is a shell whose PATH has no git, which an editor-launched
  // dev server can easily have, so say so rather than leaving someone to
  // wonder why the footer lost its sha.
  if (sha === undefined && existsSync(join(REPO_ROOT, ".git"))) {
    console.warn(
      "build-info: this is a git repository, but git could not be run — " +
        "reporting an unidentified build.\n" +
        "  Usually a PATH without git. The version readout will show no commit.",
    );
  }

  return {
    version,
    gitSha: sha ?? UNKNOWN,
    // Sliced from the full sha rather than asked of git separately, so the
    // short form is derived from the value actually reported and the two cannot
    // disagree. 7 characters is git's own default and what GitHub displays.
    gitShortSha: sha === undefined ? UNKNOWN : sha.slice(0, 7),
    buildTime,
    gitRef: ref ?? UNKNOWN,
    dirty,
  };
}

/**
 * Whether the record names a real commit.
 *
 * Duplicated from `isIdentified` in packages/shared rather than imported: this
 * script runs before and during the build that compiles that package, so it
 * cannot depend on its output. The shape is pinned by a test on both sides.
 */
export function isIdentified(info) {
  return info.gitSha !== UNKNOWN;
}

/** `KEY=value` lines for `$GITHUB_ENV`, so later workflow steps share one record. */
export function toEnvLines(info) {
  return [
    `BUILD_VERSION=${info.version}`,
    `BUILD_SHA=${info.gitSha}`,
    `BUILD_SHORT_SHA=${info.gitShortSha}`,
    `BUILD_TIME=${info.buildTime}`,
    `BUILD_REF=${info.gitRef}`,
    `BUILD_DIRTY=${String(info.dirty)}`,
  ].join("\n");
}

// Only when run directly, so importing this from a bundler config is silent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const info = resolveBuildInfo();

  // A released artifact that cannot say which commit it came from defeats the
  // point of publishing provenance for it, and the failure is invisible once
  // deployed — the UI just shows "0.0.0". The release workflow passes this flag
  // so that build fails loudly instead.
  if (process.argv.includes("--require-identified") && !isIdentified(info)) {
    console.error(
      "build-info: no commit sha resolved.\n" +
        "  A release artifact must record the commit it was built from.\n" +
        "  Set BUILD_SHA, or build inside a git work tree.",
    );
    process.exit(1);
  }

  console.log(
    process.argv.includes("--env")
      ? toEnvLines(info)
      : JSON.stringify(info, null, 2),
  );
}
