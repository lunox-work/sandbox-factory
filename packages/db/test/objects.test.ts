import assert from "node:assert/strict";
import { test } from "node:test";

import { NoSuchKey, NotFound, S3Client } from "@aws-sdk/client-s3";

import { createObjectStore, isNotFound } from "../src/objects.js";

const options = {
  endpoint: "http://localhost:8333",
  bucket: "sandbox-factory",
  credentials: { accessKeyId: "key", secretAccessKey: "secret" },
};

/**
 * Replaces the client's `send` for one test. The store builds its own client,
 * so the seam is the prototype, patched and restored per test.
 */
function stubSend(impl: (command: unknown) => Promise<unknown>): () => void {
  const original = S3Client.prototype.send;
  Object.assign(S3Client.prototype, { send: impl });
  return () => {
    Object.assign(S3Client.prototype, { send: original });
  };
}

function notFoundError(): Error {
  return new NotFound({ $metadata: { httpStatusCode: 404 }, message: "" });
}

test("put sends the body and key", async () => {
  const seen: Record<string, unknown>[] = [];
  const restore = stubSend(async (command) => {
    seen.push((command as { input: Record<string, unknown> }).input);
    return {};
  });
  try {
    await createObjectStore(options).put("a/b.txt", new Uint8Array([1, 2]), {
      contentType: "text/plain",
    });
  } finally {
    restore();
  }
  assert.equal(seen[0]?.["Key"], "a/b.txt");
  assert.equal(seen[0]?.["Bucket"], "sandbox-factory");
  assert.equal(seen[0]?.["ContentType"], "text/plain");
});

test("put omits ContentType when none is given", async () => {
  const seen: Record<string, unknown>[] = [];
  const restore = stubSend(async (command) => {
    seen.push((command as { input: Record<string, unknown> }).input);
    return {};
  });
  try {
    await createObjectStore(options).put("a.txt", new Uint8Array([1]));
  } finally {
    restore();
  }
  assert.equal("ContentType" in (seen[0] ?? {}), false);
});

test("get returns the bytes", async () => {
  const restore = stubSend(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array([7, 8]) },
  }));
  try {
    assert.deepEqual(
      await createObjectStore(options).get("a.txt"),
      new Uint8Array([7, 8]),
    );
  } finally {
    restore();
  }
});

test("get returns undefined when the body is absent", async () => {
  const restore = stubSend(async () => ({}));
  try {
    assert.equal(await createObjectStore(options).get("a.txt"), undefined);
  } finally {
    restore();
  }
});

test("get returns undefined for a missing key", async () => {
  const restore = stubSend(async () => {
    throw new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "" });
  });
  try {
    assert.equal(await createObjectStore(options).get("gone.txt"), undefined);
  } finally {
    restore();
  }
});

test("get rethrows errors that are not a missing key", async () => {
  const restore = stubSend(async () => {
    throw new Error("connection refused");
  });
  try {
    await assert.rejects(
      () => createObjectStore(options).get("a.txt"),
      /connection refused/,
    );
  } finally {
    restore();
  }
});

test("exists is true when the head succeeds", async () => {
  const restore = stubSend(async () => ({}));
  try {
    assert.equal(await createObjectStore(options).exists("a.txt"), true);
  } finally {
    restore();
  }
});

test("exists is false for a missing key", async () => {
  const restore = stubSend(async () => {
    throw notFoundError();
  });
  try {
    assert.equal(await createObjectStore(options).exists("gone.txt"), false);
  } finally {
    restore();
  }
});

test("exists rethrows unexpected errors", async () => {
  const restore = stubSend(async () => {
    throw new Error("boom");
  });
  try {
    await assert.rejects(
      () => createObjectStore(options).exists("a.txt"),
      /boom/,
    );
  } finally {
    restore();
  }
});

test("remove sends a delete", async () => {
  const seen: Record<string, unknown>[] = [];
  const restore = stubSend(async (command) => {
    seen.push((command as { input: Record<string, unknown> }).input);
    return {};
  });
  try {
    await createObjectStore(options).remove("a.txt");
  } finally {
    restore();
  }
  assert.equal(seen[0]?.["Key"], "a.txt");
});

test("signedUrl returns a presigned url for the key", async () => {
  const url = await createObjectStore(options).signedUrl("a/b.txt", 60);
  assert.match(url, /^http:\/\/localhost:8333\/sandbox-factory\/a\/b\.txt/);
  assert.match(url, /X-Amz-Expires=60/);
});

test("signedUrl defaults to a 15 minute expiry", async () => {
  const url = await createObjectStore(options).signedUrl("a.txt");
  assert.match(url, /X-Amz-Expires=900/);
});

/**
 * The production shape: a bucket and nothing else. No endpoint means AWS
 * itself, and no keys means the SDK's default chain — whose first link is the
 * environment, so setting it here stands in for the task role without
 * reaching for whatever credentials the machine running the tests holds.
 */
test("with no endpoint or keys, the client targets AWS and the default chain", async () => {
  const saved = {
    id: process.env["AWS_ACCESS_KEY_ID"],
    secret: process.env["AWS_SECRET_ACCESS_KEY"],
  };
  process.env["AWS_ACCESS_KEY_ID"] = "from-the-chain";
  process.env["AWS_SECRET_ACCESS_KEY"] = "chain-secret";
  try {
    const url = await createObjectStore({
      bucket: "avatars-bucket",
      region: "us-east-1",
    }).signedUrl("a.txt");
    assert.match(
      url,
      /^https:\/\/s3\.us-east-1\.amazonaws\.com\/avatars-bucket\/a\.txt/,
    );
    assert.match(url, /X-Amz-Credential=from-the-chain%2F/);
  } finally {
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", saved.id],
      ["AWS_SECRET_ACCESS_KEY", saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("isNotFound recognises a bare 404 from a non-AWS gateway", () => {
  assert.equal(isNotFound({ $metadata: { httpStatusCode: 404 } }), true);
});

test("isNotFound rejects other errors and non-objects", () => {
  assert.equal(isNotFound({ $metadata: { httpStatusCode: 500 } }), false);
  assert.equal(isNotFound(new Error("nope")), false);
  assert.equal(isNotFound(null), false);
  assert.equal(isNotFound("404"), false);
});
