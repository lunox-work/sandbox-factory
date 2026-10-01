import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { verifySignature } from "../src/index.js";

/**
 * GitHub's own published vector, from "Validating webhook deliveries": if
 * this fails, the implementation disagrees with GitHub rather than with us.
 */
const GITHUB_SECRET = "It's a Secret to Everybody";
const GITHUB_PAYLOAD = "Hello, World!";
const GITHUB_SIGNATURE =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

const secret = "webhook-secret";
const body = JSON.stringify({ action: "created", installation: { id: 9 } });
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("GitHub's published vector verifies", () => {
  assert.equal(
    verifySignature(GITHUB_SECRET, GITHUB_PAYLOAD, GITHUB_SIGNATURE),
    true,
  );
});

test("a delivery signed with the secret verifies, as text or as bytes", () => {
  assert.equal(verifySignature(secret, body, signature), true);
  assert.equal(
    verifySignature(secret, new TextEncoder().encode(body), signature),
    true,
  );
  // Hex case is not part of the signature.
  assert.equal(
    verifySignature(
      secret,
      body,
      signature.toUpperCase().replace("SHA256=", "sha256="),
    ),
    true,
  );
});

test("the wrong secret does not verify", () => {
  assert.equal(verifySignature("another-secret", body, signature), false);
});

test("a tampered body does not verify", () => {
  assert.equal(
    verifySignature(secret, body.replace('"id":9', '"id":10'), signature),
    false,
  );
});

test("a missing or malformed header is false, never a throw", () => {
  for (const header of [
    undefined,
    null,
    "",
    "sha1=abc",
    signature.replace("sha256=", "sha512="),
    "sha256=nothex",
    `${signature}00`,
    signature.slice(0, -2),
  ]) {
    assert.equal(verifySignature(secret, body, header), false, String(header));
  }
});

test("an empty secret verifies nothing", () => {
  // Otherwise an unconfigured secret would accept HMAC("", body), which
  // anyone can compute.
  const unkeyed = `sha256=${createHmac("sha256", "").update(body).digest("hex")}`;
  assert.equal(verifySignature("", body, unkeyed), false);
});
