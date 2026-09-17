/**
 * The digest of the running image, asked of the ECS agent rather than of the
 * build. Every other build field is a string a build arg supplied; this one is
 * what the runtime pulled, so provenance can be checked against it:
 *
 *   gh api /repos/lunox-work/sandbox-factory/attestations/sha256:...
 *
 * `gh api`, not `gh attestation verify`: verify needs the image itself, which
 * sits in a private ECR repository. See docs/versioning.md.
 */

/**
 * The endpoint is link-local and normally answers in milliseconds; the bound
 * only stops a wedged agent from hanging boot.
 */
const METADATA_TIMEOUT_MS = 1_000;

/**
 * The one field read from the ECS metadata response. Deliberately not schema
 * validated: the shape varies by launch type and agent version, and a strict
 * parse would turn a cosmetic surprise into a boot crash.
 */
interface ContainerMetadata {
  readonly ImageID?: unknown;
}

/**
 * The digest of the image this container was started from, or undefined.
 *
 * Undefined is a normal answer: there is no ECS agent locally or in tests.
 * Every failure resolves to it, because a reporting field must never stop the
 * server from starting.
 */
export async function resolveImageDigest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const uri = env.ECS_CONTAINER_METADATA_URI_V4;
  if (uri === undefined || uri === "") {
    return undefined;
  }

  try {
    const response = await fetch(uri, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as ContainerMetadata;
    return normaliseDigest(body.ImageID);
  } catch {
    // Not logged: a warning on every local boot would train people to ignore
    // it, and the absence already shows in `GET /version`.
    return undefined;
  }
}

/**
 * `ImageID` as a bare `sha256:...` digest, or undefined if it is not one.
 *
 * The agent reports either the digest alone or `<registry>/<repo>@sha256:...`;
 * the attestation is keyed by the digest alone. Malformed values are dropped,
 * since this gets pasted into a verification command.
 */
function normaliseDigest(imageId: unknown): string | undefined {
  if (typeof imageId !== "string") {
    return undefined;
  }
  const digest = imageId.slice(imageId.lastIndexOf("@") + 1);
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}
