/**
 * Resolves a build's provenance record. One resolver for all four build sites
 * (Vite, esbuild, the API's Docker build, CI), because the web app compares
 * its sha against the API's. Environment wins over git: CI knows its commit
 * exactly, and a container build has no .git.
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
 * Runs a git command; undefined when git or .git is missing or the command
 * fails. Callers fall back rather than abort: a container build is the normal
 * case, not an error.
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
 * The fallback version, from `packages/core/package.json`: the publishable
 * workspace (the apps are all private `0.0.0`). CD passes the version it is
 * releasing explicitly as BUILD_VERSION.
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
 * Whether the working tree has uncommitted changes. Git unavailable reads as
 * clean: calling a container build dirty for having no .git would put `-dirty`
 * on every released version string.
 */
function isDirty() {
  const status = git("status", "--porcelain");
  return status !== undefined && status !== "";
}

/**
 * Reads a variable, treating empty as absent. Docker sets an undeclared `ARG`
 * to `""`, which a plain `??` chain would accept and skip the fallback.
 */
function read(env, name) {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolves the build record. `env` is injectable so tests can drive every
 * branch without mutating `process.env`.
 */
export function resolveBuildInfo(env = process.env) {
  // BUILD_SHA (Docker build arg, other CI) is checked first so it can override
  // GITHUB_SHA even inside Actions.
  const sha =
    read(env, "BUILD_SHA") ??
    read(env, "GITHUB_SHA") ??
    git("rev-parse", "HEAD");

  // On a pull_request event `GITHUB_REF_NAME` is the synthetic `<n>/merge`
  // ref, which is accurate: that merge commit is what was built.
  const ref =
    read(env, "BUILD_REF") ??
    read(env, "GITHUB_REF_NAME") ??
    git("rev-parse", "--abbrev-ref", "HEAD");

  const version = read(env, "BUILD_VERSION") ?? packageVersion();

  // Resolved once, so every artifact from one build carries the same timestamp.
  const buildTime = read(env, "BUILD_TIME") ?? new Date().toISOString();

  // In order: an explicit BUILD_DIRTY wins (the dev containers have no git
  // binary, so the host resolves it and passes it in; without this a container
  // serving a modified tree would claim to be clean). Otherwise an injected
  // sha means there is no working tree to be dirty. Otherwise ask git.
  const explicitDirty = read(env, "BUILD_DIRTY");
  const dirty =
    explicitDirty !== undefined
      ? explicitDirty === "true"
      : read(env, "BUILD_SHA") !== undefined ||
          read(env, "GITHUB_SHA") !== undefined
        ? false
        : isDirty();

  // Falling back is right in a container but suspicious next to a .git: the
  // record comes out plausible but empty. The usual cause is a PATH without
  // git (an editor-launched dev server), so say so.
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
    // Sliced from the reported sha so the two cannot disagree. 7 characters is
    // git's default and what GitHub displays.
    gitShortSha: sha === undefined ? UNKNOWN : sha.slice(0, 7),
    buildTime,
    gitRef: ref ?? UNKNOWN,
    dirty,
  };
}

/**
 * Whether the record names a real commit. Duplicated from `isIdentified` in
 * packages/shared, not imported: this script runs before that package is
 * built. A test on both sides pins the shape.
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

  // The release workflow passes this flag so an artifact that cannot name its
  // commit fails the build instead of deploying with no sha in the UI.
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
