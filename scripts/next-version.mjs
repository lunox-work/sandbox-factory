#!/usr/bin/env node
//
// next-version.mjs — the version a commit range releases as.
//
// CD tags every deploy, so the bump has to be decided unattended, from the
// commits themselves. This reads Conventional Commit subjects between two refs
// and applies the standard Conventional Commits semver rule:
//
//   breaking (`!` or a `BREAKING CHANGE:` footer) → major
//   feat                                          → minor
//   anything else that is a release type          → patch
//   nothing releasable                            → no output, exit 1
//
//   node scripts/next-version.mjs --from sandbox-factory-v1.0.0 --to HEAD
//
// Exit 1 with no output means "nothing to release" — a docs-only or chore-only
// range. CD treats that as success and skips tagging, because cutting a version
// for a README fix would make the number meaningless.
//
// Deliberately NOT a general changelog tool. It answers one question, so CD can
// decide a tag without a release PR round trip. GitHub generates the release
// notes from the commits in the range.

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

const from = flag("--from", "");
const to = flag("--to", "HEAD");
const current = flag("--current", "");

// The release types. A commit outside this set (`chore`, `style`, `test`, …)
// is real work but not a reason to cut a version on its own.
const PATCH_TYPES = new Set(["fix", "perf", "revert", "build", "refactor"]);
const MINOR_TYPES = new Set(["feat"]);

/** `type(scope)!: subject` → {type, breaking}. Null when it is not conventional. */
export function parseSubject(subject) {
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s+(.+)$/.exec(subject.trim());
  if (m === null) {
    return null;
  }
  return { type: m[1], breaking: m[3] === "!", subject: m[4] };
}

/**
 * The bump a set of commits calls for.
 *
 * `null` when nothing in the range is releasable, which is a real answer and
 * not an error — see the header.
 */
export function bumpFor(commits) {
  let bump = null;
  for (const c of commits) {
    const parsed = parseSubject(c.subject);
    if (parsed === null) {
      continue;
    }
    if (parsed.breaking || /^BREAKING[ -]CHANGE:/m.test(c.body ?? "")) {
      return "major";
    }
    if (MINOR_TYPES.has(parsed.type)) {
      bump = "minor";
      continue;
    }
    if (PATCH_TYPES.has(parsed.type) && bump === null) {
      bump = "patch";
    }
  }
  return bump;
}

/** Applies a bump to a semver string. Pre-1.0 is not special-cased here. */
export function applyBump(version, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) {
    throw new Error(`not a semver version: ${version}`);
  }
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown bump: ${bump}`);
  }
}

/** Commits in a range, as {subject, body}. */
function readCommits(fromRef, toRef) {
  // `-z` separates records with a NUL, which is git's own answer to "a commit
  // message can contain any text I might pick as a delimiter". A literal NUL
  // cannot be passed in argv — execFileSync rejects it — so the separator is
  // requested through the flag and split out of the captured stdout.
  const range = fromRef === "" ? toRef : `${fromRef}..${toRef}`;
  const out = execFileSync("git", ["log", "-z", "--format=%s%n%b", range], {
    encoding: "utf8",
  });
  return out
    .split("\0")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [subject, ...rest] = chunk.split("\n");
      return { subject, body: rest.join("\n") };
    });
}

function main() {
  const version =
    current === ""
      ? JSON.parse(
          execFileSync("git", ["show", "HEAD:package.json"], {
            encoding: "utf8",
          }),
        ).version
      : current;

  const commits = readCommits(from, to);
  const bump = bumpFor(commits);

  if (bump === null) {
    process.stderr.write(
      `nothing releasable in ${from === "" ? to : `${from}..${to}`} ` +
        `(${commits.length} commit(s))\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${applyBump(version, bump)}\n`);
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && process.argv[1].endsWith("next-version.mjs")) {
  main();
}
