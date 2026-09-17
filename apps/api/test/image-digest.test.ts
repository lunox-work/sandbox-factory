/**
 * Tests for reading the running image digest off the ECS metadata endpoint.
 *
 * The behaviour worth pinning down is the failure handling. This field is the
 * one part of the build record that a provenance check runs against, so it has
 * two obligations that pull in opposite directions: never report a digest that
 * is not the real one, and never prevent the server from booting. Every test
 * below is one of those two.
 *
 * `fetch` is stubbed rather than a server being started. What is under test is
 * the parsing and the fallbacks, not HTTP.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resolveImageDigest } from "../src/image-digest.js";

const DIGEST = `sha256:${"a1b2c3d4".repeat(8)}`;
const URI = "http://169.254.170.2/v4/abc123";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces `fetch` with one that answers every call the same way. */
function stubFetch(responder: () => unknown): void {
  globalThis.fetch = (async () => responder()) as typeof fetch;
}

/** A metadata response carrying `ImageID` as given. */
function metadata(imageId: unknown): Response {
  return {
    ok: true,
    json: async () => ({ ImageID: imageId }),
  } as unknown as Response;
}

test("reports the digest the runtime resolved", async () => {
  stubFetch(() => metadata(DIGEST));
  assert.equal(
    await resolveImageDigest({ ECS_CONTAINER_METADATA_URI_V4: URI }),
    DIGEST,
  );
});

// Agent version and launch type decide which of the two shapes comes back, so
// both have to work. The registry host is stripped: it says where the bytes
// were stored, while the digest is the bytes, and only the digest is what
// `gh attestation verify --digest` takes.
test("strips a registry reference down to the bare digest", async () => {
  stubFetch(() =>
    metadata(
      `123456789012.dkr.ecr.us-east-1.amazonaws.com/sandbox-factory-api@${DIGEST}`,
    ),
  );
  assert.equal(
    await resolveImageDigest({ ECS_CONTAINER_METADATA_URI_V4: URI }),
    DIGEST,
  );
});

// Local development, tests, docker compose. Not an error: there genuinely is
// no image digest to report, and the absent field says exactly that.
test("reports nothing when there is no metadata endpoint", async () => {
  stubFetch(() => {
    throw new Error("fetch should not be called");
  });
  assert.equal(await resolveImageDigest({}), undefined);
  assert.equal(
    await resolveImageDigest({ ECS_CONTAINER_METADATA_URI_V4: "" }),
    undefined,
  );
});

// The obligation that matters most. A value that is not a digest must never be
// passed through to somewhere a person will paste it into a verify command.
test("rejects anything that is not a well-formed digest", async () => {
  for (const bad of [
    "not-a-digest",
    "sha256:tooshort",
    `sha512:${"a".repeat(64)}`,
    `sha256:${"A".repeat(64)}`, // uppercase: not the canonical encoding
    "",
    undefined,
    null,
    42,
    { digest: DIGEST },
  ]) {
    stubFetch(() => metadata(bad));
    assert.equal(
      await resolveImageDigest({ ECS_CONTAINER_METADATA_URI_V4: URI }),
      undefined,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

// The other obligation: a wedged or unreachable agent degrades to a missing
// field, never to a failed boot.
test("reports nothing rather than throwing when the endpoint misbehaves", async () => {
  const failures: Array<() => unknown> = [
    () => {
      throw new Error("ECONNREFUSED");
    },
    () => ({ ok: false, status: 500 }) as unknown as Response,
    () =>
      ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }) as unknown as Response,
    () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
  ];

  for (const failure of failures) {
    stubFetch(failure);
    assert.equal(
      await resolveImageDigest({ ECS_CONTAINER_METADATA_URI_V4: URI }),
      undefined,
    );
  }
});
