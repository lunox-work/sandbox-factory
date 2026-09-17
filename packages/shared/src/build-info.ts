/**
 * What a build says about where it came from. The API, the web app and the
 * extension all report this shape, so a mismatch between them is visible.
 *
 * An identifier, not a proof: the values are injected at build time and
 * repeated back. The signed provenance attestation (docs/versioning.md) is the
 * proof, and this record is what it is checked against.
 */

import { z } from "zod";

/**
 * Stand-in when nothing resolved the real values. A literal rather than empty
 * or null so a UI reads "this build did not record one", not "no version".
 * The release workflow fails rather than shipping it; see
 * `scripts/build-info.mjs`.
 */
export const UNKNOWN_BUILD = "unknown";

export const buildInfoSchema = z.object({
  /**
   * Semver of the released package, or `0.0.0` before any release. Not unique:
   * every build between two releases shares it, so the sha is the identifier.
   */
  version: z.string().min(1),
  /** Full 40-character commit sha, or `unknown`. What provenance verifies. */
  gitSha: z.string().min(1),
  /** First 7 of `gitSha` — what a person reads and quotes. */
  gitShortSha: z.string().min(1),
  /** ISO 8601, or `unknown`. When the artifact was built, not shipped. */
  buildTime: z.string().min(1),
  /** Branch or tag built, e.g. `main` or `v1.4.2`. Context for the sha. */
  gitRef: z.string().min(1),
  /**
   * Whether the tree had uncommitted changes at build time. Only ever true
   * locally; it says the sha does not fully describe this artifact.
   */
  dirty: z.boolean(),
  /**
   * Digest of the running container image, `sha256:...`. Read at runtime from
   * the container's own metadata, so unlike the other fields it is not a claim
   * the build made about itself — see `verifyCommand`.
   *
   * Optional because only the API runs as a container.
   */
  imageDigest: z.string().min(1).optional(),
});

export type BuildInfoDto = z.infer<typeof buildInfoSchema>;

/** Response body for `GET /version`; the web app compares against it. */
export const versionResponseSchema = buildInfoSchema;

/** The fallback value, shared by the injection sites and their tests. */
export const unknownBuildInfo: BuildInfoDto = {
  version: "0.0.0",
  gitSha: UNKNOWN_BUILD,
  gitShortSha: UNKNOWN_BUILD,
  buildTime: UNKNOWN_BUILD,
  gitRef: UNKNOWN_BUILD,
  dirty: false,
};

/**
 * The human-readable identifier: `1.4.2+7f3a9c1`, suffixed `-dirty` when the
 * tree was not clean. `+` is semver's build-metadata separator.
 *
 * Degrades to the bare version when the sha is unknown; `1.4.2+unknown` reads
 * like a sha named "unknown".
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
 * Link to the commit an artifact was built from. Undefined for an unidentified
 * build, since `/commit/unknown` 404s.
 */
export function commitUrl(info: BuildInfoDto): string | undefined {
  return isIdentified(info)
    ? `${REPOSITORY_URL}/commit/${info.gitSha}`
    : undefined;
}

/**
 * The tag a release is cut at, e.g. `sandbox-factory-v1.0.0`.
 *
 * The component prefix is inherited from release-please and is load-bearing:
 * `cd.yml` cuts tags in this shape and `release.yml` triggers on it. Changing
 * it orphans every existing release, and anything matching tags in another
 * shape silently never fires.
 */
export function releaseTag(version: string): string {
  return `sandbox-factory-v${version}`;
}

/**
 * Link to the GitHub release for this build, or undefined when it is not a
 * released one.
 *
 * Narrower than `commitUrl` on purpose: commits between two releases carry the
 * previous release's version without being it. `gitRef` discriminates — CD
 * builds the branch, the release workflow builds the tag.
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
 * The command that fetches this build's provenance. Only offered with a
 * digest: the attestation covers artifact bytes, not commits, so a command
 * built from a sha could never pass.
 *
 * Do not change this to `gh attestation verify`. That re-hashes the artifact,
 * and the image is in a private ECR repository, so an `oci://` command would
 * hang on an auth failure for any outside verifier.
 *
 * `gh api` returns the signed statement by digest; the caller decodes the DSSE
 * payload to read the workflow, repo and commit. It does not check the
 * Sigstore signature — for proof, verify the bundle with a Sigstore verifier.
 */
export function verifyCommand(info: BuildInfoDto): string | undefined {
  return info.imageDigest === undefined
    ? undefined
    : `gh api /repos/lunox-work/sandbox-factory/attestations/${info.imageDigest}`;
}

/**
 * Whether two surfaces are running the same commit.
 *
 * Compares the sha, not the version: versions differ across a release bump
 * mid-rollout, and different commits between releases share one.
 *
 * Unknown on either side is not a mismatch, or every local
 * `docker compose up` would show a warning.
 */
export function sameBuild(a: BuildInfoDto, b: BuildInfoDto): boolean {
  if (!isIdentified(a) || !isIdentified(b)) {
    return true;
  }
  return a.gitSha === b.gitSha;
}

/**
 * One line naming the build, for a console banner or a boot log. Carries the
 * full sha because this is what gets pasted into a bug report.
 */
export function buildBanner(name: string, info: BuildInfoDto): string {
  const parts = [`${name} ${formatVersion(info)}`];
  if (isIdentified(info)) {
    parts.push(`commit ${info.gitSha}`, `built ${info.buildTime}`);
  }
  return parts.join(" · ");
}
