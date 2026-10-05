import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { BOUNTY_RUN_KINDS } from "../src/sizing.js";
import { DESCRIPTOR_FORBIDDEN_KEYS } from "../src/sandbox/descriptor.js";
import {
  clampBountyTitle,
  normalizeSpecText,
  BOUNTY_LIMITS,
  BOUNTY_ORIGINS,
  BOUNTY_SPEC_HASH_VERSION,
  bountySpecHash,
} from "../src/bounty.js";

test("hashes the normalized title and description as a JSON tuple", async () => {
  // Version 2's encoding is pinned: migration 0046 computes it in SQL for
  // the proposals it moves from version 1, and a change here would make
  // every one stale.
  const expected = createHash("sha256")
    .update(JSON.stringify(["Fix login", "Steps:\n1. open"]))
    .digest("hex");
  assert.equal(await bountySpecHash("Fix login", "Steps:\n1. open"), expected);
  assert.equal(BOUNTY_SPEC_HASH_VERSION, 2);
});

test("ignores line endings and trailing space, not words", async () => {
  const clean = await bountySpecHash("Fix login", "One\nTwo");
  assert.equal(
    await bountySpecHash("  Fix login \r\n", "One  \r\nTwo\r\n"),
    clean,
  );
  assert.notEqual(await bountySpecHash("Fix logout", "One\nTwo"), clean);
  assert.notEqual(await bountySpecHash("Fix login", "One\nThree"), clean);
});

test("keeps fields apart so text cannot move between them", async () => {
  assert.notEqual(
    await bountySpecHash("a", "b c"),
    await bountySpecHash("a b", "c"),
  );
});

test("normalizes only whitespace at line ends and around the text", () => {
  assert.equal(normalizeSpecText("\r\n a  \r b\t\n"), "a\n b");
});

test("declares a bounty's origins and bounds", () => {
  assert.deepEqual([...BOUNTY_ORIGINS], ["manual", "jira"]);
  assert.deepEqual(BOUNTY_LIMITS, { title: 255, description: 20_000 });
  assert.ok(BOUNTY_RUN_KINDS.includes("bounty"));
  // A bounty id is private provenance, like the pointers it replaced.
  assert.ok(DESCRIPTOR_FORBIDDEN_KEYS.includes("bountyId"));
  assert.ok(DESCRIPTOR_FORBIDDEN_KEYS.includes("ticketIds"));
});

test("a title past the limit is cut, never through a character", () => {
  assert.equal(clampBountyTitle("Short"), "Short");
  const long = "x".repeat(BOUNTY_LIMITS.title + 10);
  assert.equal(clampBountyTitle(long).length, BOUNTY_LIMITS.title);
  // An emoji is two UTF-16 units; one straddling the limit is left out
  // whole rather than halved.
  const straddling = `${"x".repeat(BOUNTY_LIMITS.title - 1)}\u{1F600}tail`;
  const cut = clampBountyTitle(straddling);
  assert.equal(cut, "x".repeat(BOUNTY_LIMITS.title - 1));
  assert.equal(clampBountyTitle(cut), cut);
  const fits = `${"x".repeat(BOUNTY_LIMITS.title - 2)}\u{1F600}tail`;
  assert.equal(
    clampBountyTitle(fits),
    `${"x".repeat(BOUNTY_LIMITS.title - 2)}\u{1F600}`,
  );
});
