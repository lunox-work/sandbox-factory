/**
 * What a build says about where it came from.
 *
 * Every surface — the API, the web app, the extension — reports the same
 * shape, so "which version are you running?" has one answer format across all
 * three and a mismatch between two of them is visible rather than inferred.
 *
 * This is an *identifier*, not a proof. The values are injected at build time
 * and the running code simply repeats them, so anyone who controls a build can
 * put anything here. Cryptographic proof that an artifact came from a given
 * commit is a separate mechanism — the signed provenance attestation described
 * in docs/versioning.md — and this record is what that attestation is checked
 * against.
 */

import { z } from "zod";

/**
 * Stand-in when nothing resolved the real values: a local `vite build` with no
 * git, a test, a container built without the build args.
 *
 * A literal rather than an empty string or null, because those read as "there
 * is no version" in a UI, while this reads as "this build did not record one" —
 * which is the actual situation and a bug worth noticing in a deployed artifact.
 * The release workflow fails the build rather than shipping it; see
 * `scripts/build-info.mjs`.
 */
export const UNKNOWN_BUILD = "unknown";

export const buildInfoSchema = z.object({
  /**
   * Semver from the released package, or `0.0.0` for a build that predates any
   * release. Not unique on its own: every build between two releases carries
   * the same version, which is why the sha below is the real identifier.
   */
  version: z.string().min(1),
  /** Full 40-character commit sha, or `unknown`. What provenance verifies. */
  gitSha: z.string().min(1),
  /** First 7 of `gitSha` — what a person reads and quotes. */
  gitShortSha: z.string().min(1),
  /** ISO 8601, or `unknown`. When the artifact was built, not when it shipped. */
  buildTime: z.string().min(1),
  /** Branch or tag built, e.g. `main` or `v1.4.2`. Context for the sha. */
  gitRef: z.string().min(1),
  /**
   * Whether the working tree had uncommitted changes at build time.
   *
   * Only ever true for a local build, and the single most useful field here
   * when one is behaving differently from what the commit would predict: it
   * says the sha does not fully describe this artifact.
   */
  dirty: z.boolean(),
});

export type BuildInfoDto = z.infer<typeof buildInfoSchema>;

/** Response body for `GET /version`, and the shape the web app compares against. */
export const versionResponseSchema = buildInfoSchema;

/**
 * The value a build falls back to. Exported so the injection sites and their
 * tests share one definition rather than three copies that drift.
 */
export const unknownBuildInfo: BuildInfoDto = {
  version: "0.0.0",
  gitSha: UNKNOWN_BUILD,
  gitShortSha: UNKNOWN_BUILD,
  buildTime: UNKNOWN_BUILD,
  gitRef: UNKNOWN_BUILD,
  dirty: false,
};

/**
 * The human-readable identifier: `1.4.2+7f3a9c1`, `+dirty` when the tree was
 * not clean.
 *
 * `+` is semver's build-metadata separator, which is exactly what this is:
 * metadata that identifies the build without participating in precedence.
 * Two builds of the same commit sort equal, which is correct — they are the
 * same release.
 *
 * Degrades to the bare version when the sha is unknown, rather than printing
 * `1.4.2+unknown`, which reads like a sha named "unknown".
 */
export function formatVersion(info: BuildInfoDto): string {
  const suffix = info.dirty ? "-dirty" : "";
  if (info.gitShortSha === UNKNOWN_BUILD) {
    return `${info.version}${suffix}`;
  }
  return `${info.version}+${info.gitShortSha}${suffix}`;
}

/** Whether this build recorded where it came from. */
export function isIdentified(info: BuildInfoDto): boolean {
  return info.gitSha !== UNKNOWN_BUILD;
}

const REPOSITORY_URL = "https://github.com/lunox-work/sandbox-factory";

/**
 * Link to the exact commit an artifact was built from, so the sha in the UI is
 * checkable in one click rather than being a string to copy and paste.
 *
 * Undefined for an unidentified build: a link to `/commit/unknown` 404s, and
 * offering it is worse than offering nothing.
 */
export function commitUrl(info: BuildInfoDto): string | undefined {
  return isIdentified(info)
    ? `${REPOSITORY_URL}/commit/${info.gitSha}`
    : undefined;
}

/**
 * Whether two surfaces are running the same commit.
 *
 * Compares the full sha, not the version: two builds either side of a release
 * bump differ in version while a rolling deploy is in flight, and two different
 * commits between releases share one version. The sha is the only field that
 * answers this.
 *
 * Unknown on either side is not a mismatch — an unidentified build makes the
 * question unanswerable, and reporting that as "these differ" would show a
 * warning on every local `docker compose up`.
 */
export function sameBuild(a: BuildInfoDto, b: BuildInfoDto): boolean {
  if (!isIdentified(a) || !isIdentified(b)) {
    return true;
  }
  return a.gitSha === b.gitSha;
}

/**
 * One line naming the build, for a console banner or a log on boot.
 *
 * Carries the full sha rather than the short one because this is the copy that
 * gets pasted into a bug report, and provenance verification takes the full sha.
 */
export function buildBanner(name: string, info: BuildInfoDto): string {
  const parts = [`${name} ${formatVersion(info)}`];
  if (isIdentified(info)) {
    parts.push(`commit ${info.gitSha}`, `built ${info.buildTime}`);
  }
  return parts.join(" · ");
}
