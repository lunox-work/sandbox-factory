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
  /**
   * Digest of the container image this process is running, `sha256:...`.
   *
   * The one field here that is not a claim the build made about itself. The
   * others are injected at build time and repeated back; this one is read at
   * runtime from the container runtime's own metadata, so it says what is
   * actually executing rather than what a build argument said should be.
   *
   * That is what makes it verifiable. Given the digest, anyone can run
   * `gh api /repos/lunox-work/sandbox-factory/attestations/<digest>` and get
   * back the signed statement naming the workflow and commit that produced
   * those exact bytes, without trusting this response. See docs/versioning.md.
   *
   * Optional because only the API runs as a container: the web bundle is a set
   * of files on a CDN with no single digest, and a local `npm run dev` has no
   * image at all.
   */
  imageDigest: z.string().min(1).optional(),
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
 * The tag release-please creates for a release, e.g. `sandbox-factory-v1.0.0`.
 *
 * The component prefix is not decoration. `release-please-config.json`
 * configures `packages/core` as a named package in a manifest-driven monorepo,
 * where `include-component-in-tag` defaults to true — so the tags that exist
 * are `sandbox-factory-v1.0.0`, never `v1.0.0`. Anything matching on tags has
 * to match this shape or it silently never fires.
 */
export function releaseTag(version: string): string {
  return `sandbox-factory-v${version}`;
}

/**
 * Link to the GitHub release a build corresponds to — the changelog, the
 * signed artifacts — or undefined when this build is not a released one.
 *
 * Deliberately narrower than `commitUrl`, which resolves for every build. Only
 * the commit a release was tagged at has a release page; every commit between
 * two releases carries the previous release's version while not being it, and
 * linking those to that release page would claim they are something they are
 * not. `gitRef` is the discriminator: CD sets it to the branch (`main`), while
 * the release workflow builds a tag, so a ref matching the tag for this
 * version is the artifact's own statement that it was built as that release.
 */
export function releaseUrl(info: BuildInfoDto): string | undefined {
  if (!isIdentified(info)) {
    return undefined;
  }
  const tag = releaseTag(info.version);
  return info.gitRef === tag
    ? `${REPOSITORY_URL}/releases/tag/${tag}`
    : undefined;
}

/**
 * The command that fetches this build's provenance, for the person who wants to
 * check rather than trust.
 *
 * Only offered when there is a digest, because the digest is the only thing
 * here a signature is bound to. A command built from a sha would invite a check
 * that cannot pass — the attestation covers artifact bytes, not commits.
 *
 * This is `gh api`, not `gh attestation verify`, and the distinction is not a
 * detail. `verify` re-hashes the artifact it is given, so it needs the artifact
 * — a local file, or an `oci://` reference it can pull. Our image lives in a
 * private ECR repository, so an outside verifier can do neither, and an
 * `oci://` command printed here would just hang on an auth failure and make a
 * verifiable build look unverifiable.
 *
 * What this returns instead is the signed statement itself, looked up by
 * digest. The caller decodes the DSSE payload and reads which workflow, repo
 * and commit produced those bytes. That is a weaker operation than `verify` —
 * it does not by itself check the Sigstore signature — so anyone treating this
 * as proof should verify the bundle with a Sigstore verifier, or pull the image
 * and use `gh attestation verify oci://...` if they have registry access.
 */
export function verifyCommand(info: BuildInfoDto): string | undefined {
  return info.imageDigest === undefined
    ? undefined
    : `gh api /repos/lunox-work/sandbox-factory/attestations/${info.imageDigest}`;
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
