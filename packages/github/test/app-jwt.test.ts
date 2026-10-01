import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { appJwt, readPrivateKey } from "../src/index.js";
import { keys } from "./helpers.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(segment, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

test("the JWT verifies against the App's public key", () => {
  const token = appJwt({ appId: "123", privateKey: keys.privateKey, now: NOW });
  const [header, payload, signature] = token.split(".");

  assert.ok(header !== undefined && payload !== undefined && signature);
  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(keys.publicKey, signature, "base64url");
  assert.equal(valid, true);
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
});

test("iat is backdated a minute and exp is nine minutes ahead", () => {
  // GitHub refuses an exp more than ten minutes out, and an iat in its
  // future; both margins are for clocks that disagree.
  const token = appJwt({ appId: "123", privateKey: keys.privateKey, now: NOW });
  const claims = decode(token.split(".")[1] ?? "");

  assert.equal(claims["iss"], "123");
  assert.equal(claims["iat"], NOW / 1000 - 60);
  assert.equal(claims["exp"], NOW / 1000 + 9 * 60);
});

test("a tampered payload no longer verifies", () => {
  const token = appJwt({ appId: "123", privateKey: keys.privateKey, now: NOW });
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ iss: "999" })).toString(
    "base64url",
  );

  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${forged}`)
    .verify(keys.publicKey, signature ?? "", "base64url");
  assert.equal(valid, false);
});

test("the key reads from the PEM or from base64 of it", () => {
  // Base64 is how it is stored: an ECS environment value cannot carry the
  // PEM's newlines cleanly.
  const pem = keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const fromPem = readPrivateKey(pem);
  const fromBase64 = readPrivateKey(Buffer.from(pem).toString("base64"));

  assert.equal(fromPem.asymmetricKeyType, "rsa");
  assert.equal(fromBase64.asymmetricKeyType, "rsa");
});

test("a value that is not a private key is refused without echoing it", () => {
  assert.throws(
    () => readPrivateKey("bm90IGEga2V5"),
    (error: Error) =>
      /neither base64 of a PEM private key/.test(error.message) &&
      !error.message.includes("bm90IGEga2V5"),
  );
});

test("a PEM with its newlines written as \\n reads like the real one", () => {
  // How a PEM pasted onto one line of a .env file arrives.
  const pem = keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const escaped = pem.trimEnd().split("\n").join("\\n");
  assert.ok(!escaped.includes("\n"));

  const key = readPrivateKey(escaped);

  assert.equal(key.asymmetricKeyType, "rsa");
});

test("a PKCS#8 PEM reads too, not only GitHub's PKCS#1", () => {
  const pem = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  assert.equal(readPrivateKey(pem).asymmetricKeyType, "rsa");
});

test("a broken PEM says to store base64 instead, without echoing it", () => {
  const broken =
    "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";

  assert.throws(
    () => readPrivateKey(broken),
    (error: Error) =>
      /Store it as base64/.test(error.message) &&
      !error.message.includes("not-a-key"),
  );
});

test("a non-RSA key is refused, since GitHub signs with RS256 only", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  assert.throws(() => readPrivateKey(pem), /must be an RSA key/);
});
