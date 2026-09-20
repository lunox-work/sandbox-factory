import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  createTokenCipher,
  sameKeyId,
  TokenCipherError,
} from "../src/cipher.js";

const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

test("a token round-trips", () => {
  const cipher = createTokenCipher(key);
  const token = "refresh-token-from-atlassian";

  assert.equal(cipher.decrypt(cipher.encrypt(token)), token);
});

test("the ciphertext does not contain the token", () => {
  // The whole point: a database dump, a log line or a backup must not carry
  // a usable credential.
  const cipher = createTokenCipher(key);

  const encrypted = cipher.encrypt("super-secret-value") ?? "";

  assert.ok(!encrypted.includes("super-secret-value"));
  assert.match(encrypted, /^v1:/);
});

test("encrypting twice gives different ciphertexts", () => {
  // A fresh IV each time. Without it, equal tokens would be visibly equal in
  // the table, which leaks that two connections share a credential.
  const cipher = createTokenCipher(key);

  assert.notEqual(cipher.encrypt("same"), cipher.encrypt("same"));
});

test("null passes through both ways", () => {
  // `refresh_token` is genuinely nullable: a grant without `offline_access`
  // has none.
  const cipher = createTokenCipher(key);

  assert.equal(cipher.encrypt(null), null);
  assert.equal(cipher.decrypt(null), null);
});

test("an empty token is encrypted, not treated as absent", () => {
  const cipher = createTokenCipher(key);

  assert.equal(cipher.decrypt(cipher.encrypt("")), "");
});

test("a unicode token round-trips", () => {
  const cipher = createTokenCipher(key);
  const token = "tökèn-🔐-ünïcode";

  assert.equal(cipher.decrypt(cipher.encrypt(token)), token);
});

test("the wrong key fails loudly rather than returning nonsense", () => {
  // GCM authenticates, so this cannot quietly yield a plausible wrong token
  // that then fails against Atlassian as a confusing 401.
  const written = createTokenCipher(key).encrypt("token");

  assert.throws(
    () => createTokenCipher(otherKey).decrypt(written),
    TokenCipherError,
  );
});

test("a tampered ciphertext fails to authenticate", () => {
  const cipher = createTokenCipher(key);
  const encrypted = cipher.encrypt("token") ?? "";

  // Flip a byte of the body.
  const packed = Buffer.from(encrypted.slice(3), "base64");
  const last = packed.length - 1;
  packed.writeUInt8(packed.readUInt8(last) ^ 0xff, last);
  const tampered = `v1:${packed.toString("base64")}`;

  assert.throws(() => cipher.decrypt(tampered), TokenCipherError);
});

test("a tampered authentication tag is rejected", () => {
  const cipher = createTokenCipher(key);
  const encrypted = cipher.encrypt("token") ?? "";

  const packed = Buffer.from(encrypted.slice(3), "base64");
  packed.writeUInt8(packed.readUInt8(12) ^ 0xff, 12); // First byte of the tag.
  assert.throws(
    () => cipher.decrypt(`v1:${packed.toString("base64")}`),
    TokenCipherError,
  );
});

test("a plaintext value is refused rather than returned as-is", () => {
  // If an un-encrypted token ever reached the column, returning it would hide
  // the bug this exists to prevent.
  const cipher = createTokenCipher(key);

  assert.throws(() => cipher.decrypt("plain-token"), TokenCipherError);
});

test("a truncated column is refused", () => {
  const cipher = createTokenCipher(key);

  assert.throws(
    () => cipher.decrypt(`v1:${Buffer.alloc(8).toString("base64")}`),
    TokenCipherError,
  );
});

test("a key of the wrong length is refused at construction", () => {
  // On boot, not at the first connection attempt.
  assert.throws(
    () => createTokenCipher(randomBytes(31).toString("base64")),
    TokenCipherError,
  );
  assert.throws(() => createTokenCipher(""), TokenCipherError);
});

test("the key id is stable for a key and differs between keys", () => {
  // Rotation reads it to decide which rows still need re-encrypting.
  assert.equal(createTokenCipher(key).keyId, createTokenCipher(key).keyId);
  assert.notEqual(
    createTokenCipher(key).keyId,
    createTokenCipher(otherKey).keyId,
  );
});

test("the key id does not contain the key", () => {
  const cipher = createTokenCipher(key);

  assert.ok(!key.includes(cipher.keyId));
  assert.match(cipher.keyId, /^[0-9a-f]{12}$/);
});

test("an explicit key id overrides the derived one", () => {
  assert.equal(createTokenCipher(key, { keyId: "2026-09" }).keyId, "2026-09");
});

test("rotation: both keys readable at once, so no row is unreadable", () => {
  // What makes rotation a re-encrypt rather than a migration. Rows written
  // under the old key keep working while the new key is in use.
  const oldCipher = createTokenCipher(key, { keyId: "old" });
  const newCipher = createTokenCipher(otherKey, { keyId: "new" });
  const legacyRow = {
    token: oldCipher.encrypt("token"),
    keyId: oldCipher.keyId,
  };

  const byId = new Map([
    [oldCipher.keyId, oldCipher],
    [newCipher.keyId, newCipher],
  ]);
  const plaintext = byId.get(legacyRow.keyId)?.decrypt(legacyRow.token);
  const reEncrypted = {
    token: newCipher.encrypt(plaintext ?? null),
    keyId: newCipher.keyId,
  };

  assert.equal(plaintext, "token");
  assert.equal(newCipher.decrypt(reEncrypted.token), "token");
});

test("sameKeyId compares without leaking length through an early return", () => {
  assert.equal(sameKeyId("abc123", "abc123"), true);
  assert.equal(sameKeyId("abc123", "abc124"), false);
  assert.equal(sameKeyId("abc", "abc123"), false);
});
