/**
 * What image this process is actually running, asked of the runtime rather
 * than of the build.
 *
 * Every other field in the build record is a string a build argument put
 * there: the process repeats it back, and a build that wanted to lie could put
 * anything in it. This one is different in kind. ECS injects
 * `ECS_CONTAINER_METADATA_URI_V4` into every task, and the endpoint behind it
 * is served by the agent on the host, describing the container as the host
 * sees it. The digest it returns is the one the runtime resolved when it
 * pulled, so it names the bytes that are executing.
 *
 * That is the field a provenance check can be run against:
 *
 *   gh api /repos/lunox-work/sandbox-factory/attestations/sha256:...
 *
 * The signature is bound to the digest, so that returns the signed statement
 * naming which workflow built these exact bytes, and from which commit,
 * without trusting this server's own account of itself.
 *
 * Note it is `gh api` rather than `gh attestation verify`: verify re-hashes the
 * artifact it is handed, so it needs the image itself, which lives in a private
 * ECR repository an outside party cannot pull from. There is no bare-digest
 * form of verify. See docs/versioning.md.
 */

/**
 * How long to wait for the metadata endpoint.
 *
 * It is a link-local address on the host, so a healthy response takes single
 * -digit milliseconds. A second is already far outside normal; the point of the
 * bound is that boot cannot hang on a reporting nicety if the agent is wedged.
 */
const METADATA_TIMEOUT_MS = 1_000;

/**
 * The subset of the ECS task metadata response this cares about.
 *
 * Deliberately not validated with a schema. The endpoint returns a large
 * document whose shape varies by launch type and agent version, and the
 * failure mode for an unexpected field here is "report no digest", which is
 * already handled — a strict parse would turn a cosmetic surprise into a
 * boot-time crash.
 */
interface ContainerMetadata {
  readonly ImageID?: unknown;
}

/**
 * The digest of the image this container was started from, or undefined when
 * that cannot be established.
 *
 * Undefined is a normal answer, not an error: local development, tests, and
 * `docker compose up` all run without an ECS agent, and there genuinely is no
 * digest to report there. Every failure — no metadata URI, a refused
 * connection, a timeout, an unparseable body, a missing field — converges on
 * it, because they all mean the same thing to a caller, and because this is a
 * reporting field that must never be able to prevent the server from starting.
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
    // Every failure is the same answer. Swallowed rather than logged, because
    // the absence shows up in `GET /version` as a missing field, and a warning
    // on every local boot would train people to ignore the log line.
    return undefined;
  }
}

/**
 * `ImageID` as a bare `sha256:...` digest, or undefined if it is not one.
 *
 * The agent reports this field in two shapes depending on version and launch
 * type: the digest alone, or the image reference with the digest appended
 * (`123456789012.dkr.ecr.us-east-1.amazonaws.com/sandbox-factory-api@sha256:...`).
 * Only the digest is wanted — the registry host is an implementation detail of
 * where the bytes were stored, while the digest is the bytes themselves, and
 * the digest alone is what the attestation is keyed by.
 *
 * Anything that does not end in a well-formed digest is dropped rather than
 * passed through. A caller is going to paste this into a verification command,
 * and a malformed value that produces a confusing error from another tool is
 * worse than an absent one that reads as "not available here".
 */
function normaliseDigest(imageId: unknown): string | undefined {
  if (typeof imageId !== "string") {
    return undefined;
  }
  const digest = imageId.slice(imageId.lastIndexOf("@") + 1);
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}
