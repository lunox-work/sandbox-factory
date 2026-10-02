import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { createObjectStore } from "../src/objects.js";

/** Local SeaweedFS (also started by CI), never a configured production bucket. */
test("streaming uploads preserve bytes and browser-host signed downloads on SeaweedFS", async (t) => {
  const endpoint = process.env["TEST_S3_ENDPOINT"] ?? "http://127.0.0.1:8333";
  const address = new URL(endpoint);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)) {
    t.skip("Object storage fixture must be local");
    return;
  }
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
  } catch {
    if (process.env["CI"] === "true")
      throw new Error("The CI SeaweedFS fixture is not reachable.");
    t.skip("No local SeaweedFS fixture reachable");
    return;
  }
  const bucket = `analysis-test-${randomUUID()}`;
  const credentials = {
    accessKeyId: "sandbox",
    secretAccessKey: "sandboxsecret",
  };
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const publicEndpoint = `${address.protocol}//localhost:${address.port}`;
  const store = createObjectStore({
    endpoint,
    publicEndpoint,
    bucket,
    credentials,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  const content = Buffer.from(
    "<html><body>Private graph fixture</body></html>",
  );
  const key = "runs/fixture/graph.html";
  try {
    await store.putStream!(key, Readable.from(content), content.length, {
      contentType: "text/html; charset=utf-8",
    });
    const url = await store.signedUrl(key, 900);
    assert.equal(new URL(url).hostname, "localhost");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(downloaded, content);
    assert.equal(
      createHash("sha256").update(downloaded).digest("hex"),
      createHash("sha256").update(content).digest("hex"),
    );
  } finally {
    await store.remove(key);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }
});
