import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  checkHandle,
  handleStemFromEmail,
  isValidHandle,
  normalizeHandle,
  toHandleCase,
  toHandleStem,
} from "../src/handle.js";

/**
 * The handle rules, shared by usernames and organization slugs. These moved
 * here from the profile store so both principals, and both browser forms,
 * apply one definition; `packages/db/test/profile.test.ts` still pins the
 * store's behaviour through them.
 */

test("a handle is stored lowercase, keeping the typed casing for display", () => {
  // Otherwise @Alice and @alice could both exist.
  assert.deepEqual(normalizeHandle("  FeverSoul  "), {
    status: "ok",
    handle: "feversoul",
    display: "FeverSoul",
  });
});

test("toHandleCase trims and lowercases without judging validity", () => {
  // The hooks normalize before a uniqueness check, which must not throw on a
  // name the caller is about to be told is invalid anyway.
  assert.equal(toHandleCase("  MyOrg "), "myorg");
  assert.equal(toHandleCase(" no spaces here "), "no spaces here");
});

test("handles that are too short or too long are refused", () => {
  for (const candidate of ["ab", "x".repeat(HANDLE_MAX_LENGTH + 1)]) {
    const result = normalizeHandle(candidate);
    assert.equal(result.status, "invalid", `expected ${candidate} invalid`);
    assert.equal(
      result.status === "invalid" ? result.problem : undefined,
      "length",
    );
  }
});

test("the boundary lengths themselves are accepted", () => {
  // An off-by-one here would refuse a name the message says is fine.
  assert.equal(normalizeHandle("x".repeat(HANDLE_MIN_LENGTH)).status, "ok");
  assert.equal(normalizeHandle("x".repeat(HANDLE_MAX_LENGTH)).status, "ok");
});

test("handles with characters that break a URL or a mention are refused", () => {
  for (const candidate of ["has space", "has/slash", "has@at", "has.dot"]) {
    const result = normalizeHandle(candidate);
    assert.equal(result.status, "invalid", `expected ${candidate} invalid`);
    assert.equal(
      result.status === "invalid" ? result.problem : undefined,
      "charset",
    );
  }
});

test("hyphens and underscores are allowed", () => {
  assert.equal(normalizeHandle("a-b_c9").status, "ok");
});

test("a rejection carries wording that can be shown as-is", () => {
  // The API returns this verbatim as its 400 body; the forms show the same.
  const result = normalizeHandle("no");
  assert.equal(result.status, "invalid");
  assert.match(
    result.status === "invalid" ? result.reason : "",
    /between 3 and 30 characters/,
  );
});

test("checkHandle judges an already-normalized handle", () => {
  // It does no trimming, so upper case fails the charset rule rather than
  // being silently accepted.
  assert.equal(checkHandle("feversoul").status, "ok");
  assert.equal(checkHandle("FeverSoul").status, "invalid");
});

test("isValidHandle answers the question a submit button asks", () => {
  assert.equal(isValidHandle(" FeverSoul "), true);
  assert.equal(isValidHandle("no"), false);
});

// ---- stems ----------------------------------------------------------------

test("a stem is derived from the local part of an address", () => {
  // The domain says where someone works, not who they are.
  assert.equal(handleStemFromEmail("dana@example.test"), "dana");
});

test("characters that are not handle-safe become hyphens", () => {
  assert.equal(
    handleStemFromEmail("rivers.dana+work@example.test"),
    "rivers-dana-work",
  );
});

test("a short stem is padded to a usable length", () => {
  assert.equal(handleStemFromEmail("jo@example.test"), "jo-user");
});

test("a long stem is truncated to the maximum length", () => {
  const stem = handleStemFromEmail(`${"x".repeat(60)}@example.test`);
  assert.ok(stem.length <= HANDLE_MAX_LENGTH, `too long: ${stem}`);
});

test("surrounding hyphens are trimmed but inner ones are kept", () => {
  assert.equal(toHandleStem("--dana--rivers--"), "dana--rivers");
});

test("a run of only hyphens does not hang", () => {
  // Pins the hand-rolled `trimHyphens`, which replaces a regex CodeQL flags
  // as polynomial ReDoS. The result is short and still invalid, which is
  // this function's documented contract: a stem is a starting point.
  assert.equal(toHandleStem("-".repeat(200)), "-user");
});

test("an organization name becomes a reasonable stem", () => {
  // What the create dialog proposes as you type the name.
  assert.equal(toHandleStem("Acme Robotics, Inc."), "acme-robotics-inc");
});

test("every stem is a valid handle, however unpromising the input", () => {
  // `suggest` hands a stem straight to a rename path that would refuse an
  // invalid one, so the padding is load-bearing rather than cosmetic.
  for (const text of ["!!!", "---", "", "   ", "a", "Acme Robotics, Inc."]) {
    const stem = toHandleStem(text);
    assert.equal(
      checkHandle(stem).status,
      "ok",
      `${JSON.stringify(text)} yielded ${JSON.stringify(stem)}`,
    );
  }
});
