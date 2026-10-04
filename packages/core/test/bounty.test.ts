import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { BOUNTY_RUN_KINDS } from "../src/sizing.js";
import { DESCRIPTOR_FORBIDDEN_KEYS } from "../src/sandbox/descriptor.js";
import {
  clampBountyTitle,
  DEFAULT_ISSUE_TYPE,
  normalizeSpecText,
  BOUNTY_LIMITS,
  BOUNTY_ORIGINS,
  BOUNTY_SPEC_HASH_VERSION,
  bountyKey,
  bountySpecHash,
} from "../src/bounty.js";

test("hashes the normalized title, description and type as a JSON tuple", async () => {
  // Version 1 is the hash proposals stored when Jira was read directly, so
  // its encoding is pinned: a change here would make every one stale.
  const expected = createHash("sha256")
    .update(JSON.stringify(["Fix login", "Steps:\n1. open", "Bug"]))
    .digest("hex");
  assert.equal(
    await bountySpecHash("Fix login", "Steps:\n1. open", "Bug"),
    expected,
  );
  assert.equal(BOUNTY_SPEC_HASH_VERSION, 1);
});

test("ignores line endings and trailing space, not words", async () => {
  const clean = await bountySpecHash("Fix login", "One\nTwo", "Bug");
  assert.equal(
    await bountySpecHash("  Fix login \r\n", "One  \r\nTwo\r\n", "Bug "),
    clean,
  );
  assert.notEqual(await bountySpecHash("Fix logout", "One\nTwo", "Bug"), clean);
  assert.notEqual(await bountySpecHash("Fix login", "One\nTwo", "Task"), clean);
});

test("keeps fields apart so text cannot move between them", async () => {
  assert.notEqual(
    await bountySpecHash("a", "b c", "Task"),
    await bountySpecHash("a b", "c", "Task"),
  );
});

test("normalizes only whitespace at line ends and around the text", () => {
  assert.equal(normalizeSpecText("\r\n a  \r b\t\n"), "a\n b");
});

test("names a bounty by its Jira key while it has one", () => {
  assert.equal(bountyKey({ number: 12 }), "B-12");
  assert.equal(bountyKey({ number: 12, jiraKey: null }), "B-12");
  assert.equal(bountyKey({ number: 12, jiraKey: "APP-4" }), "APP-4");
});

test("declares a bounty's origins, bounds and default type", () => {
  assert.deepEqual([...BOUNTY_ORIGINS], ["manual", "jira"]);
  assert.equal(BOUNTY_LIMITS.description, 20_000);
  assert.equal(DEFAULT_ISSUE_TYPE, "Task");
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
