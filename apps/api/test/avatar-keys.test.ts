import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admitsPicture,
  isAvatarRef,
  objectKey,
  parseServedPath,
  servedPath,
} from "../src/avatars/keys.js";

/**
 * The path shape is the security boundary for both picture columns: the
 * Better Auth hooks admit exactly what `admitsPicture` admits. These pin it.
 */

const HASH = "a".repeat(64);
const ref = { kind: "user" as const, id: "user_1", hash: HASH };

test("the object key and the served path share one shape", () => {
  assert.equal(objectKey(ref), `avatars/user/user_1/${HASH}.webp`);
  assert.equal(servedPath(ref), `/api/avatars/user/user_1/${HASH}.webp`);
});

test("a served path parses back to the reference it was built from", () => {
  assert.deepEqual(parseServedPath(servedPath(ref)), ref);
  assert.deepEqual(
    parseServedPath(`/api/avatars/organization/org_1/${HASH}.webp`),
    { kind: "organization", id: "org_1", hash: HASH },
  );
});

test("anything that is not exactly an avatar path does not parse", () => {
  for (const value of [
    null,
    undefined,
    42,
    "",
    // A provider's picture from signup.
    "https://avatars.githubusercontent.com/u/1?v=4",
    // Absolute, with a host in front: stored paths are relative.
    `https://evil.example/api/avatars/user/user_1/${HASH}.webp`,
    // Wrong kind, short hash, uppercase hash, wrong extension.
    `/api/avatars/team/user_1/${HASH}.webp`,
    `/api/avatars/user/user_1/${"a".repeat(63)}.webp`,
    `/api/avatars/user/user_1/${"A".repeat(64)}.webp`,
    `/api/avatars/user/user_1/${HASH}.png`,
    // Traversal and trailing junk.
    `/api/avatars/user/../user_1/${HASH}.webp`,
    `/api/avatars/user/user_1/${HASH}.webp?x=1`,
    `/api/avatars/user/user_1/${HASH}.webp/`,
  ]) {
    assert.equal(parseServedPath(value), undefined, String(value));
  }
});

test("isAvatarRef validates each untrusted segment", () => {
  assert.equal(isAvatarRef("user", "user_1", HASH), true);
  assert.equal(isAvatarRef("organization", "org-1_A", HASH), true);
  assert.equal(isAvatarRef("admin", "user_1", HASH), false);
  assert.equal(isAvatarRef("user", "user/1", HASH), false);
  assert.equal(isAvatarRef("user", "", HASH), false);
  assert.equal(isAvatarRef("user", "user_1", "abc"), false);
});

test("building a key from an invalid reference throws rather than escaping", () => {
  assert.throws(() => objectKey({ ...ref, id: "../../etc" }));
  assert.throws(() => servedPath({ ...ref, hash: "nope" }));
});

test("admitsPicture accepts null and the owner's own path, nothing else", () => {
  const owner = { kind: "user" as const, id: "user_1" };

  assert.equal(admitsPicture(null, owner), true);
  assert.equal(admitsPicture(servedPath(ref), owner), true);

  // Someone else's avatar, the other kind, and any foreign URL.
  assert.equal(
    admitsPicture(servedPath({ ...ref, id: "user_2" }), owner),
    false,
  );
  assert.equal(
    admitsPicture(servedPath({ ...ref, kind: "organization" }), owner),
    false,
  );
  assert.equal(admitsPicture("https://evil.example/x.png", owner), false);
  assert.equal(admitsPicture(undefined, owner), false);
  assert.equal(admitsPicture("", owner), false);
});
