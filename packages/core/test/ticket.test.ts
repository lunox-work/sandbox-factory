import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { BOUNTY_RUN_KINDS } from "../src/bounty.js";
import { DESCRIPTOR_FORBIDDEN_KEYS } from "../src/sandbox/descriptor.js";
import {
  DEFAULT_ISSUE_TYPE,
  normalizeSpecText,
  TICKET_LIMITS,
  TICKET_ORIGINS,
  TICKET_SPEC_HASH_VERSION,
  ticketKey,
  ticketSpecHash,
} from "../src/ticket.js";

test("hashes the normalized title, description and type as a JSON tuple", async () => {
  // Version 1 is the hash proposals stored when Jira was read directly, so
  // its encoding is pinned: a change here would make every one stale.
  const expected = createHash("sha256")
    .update(JSON.stringify(["Fix login", "Steps:\n1. open", "Bug"]))
    .digest("hex");
  assert.equal(
    await ticketSpecHash("Fix login", "Steps:\n1. open", "Bug"),
    expected,
  );
  assert.equal(TICKET_SPEC_HASH_VERSION, 1);
});

test("ignores line endings and trailing space, not words", async () => {
  const clean = await ticketSpecHash("Fix login", "One\nTwo", "Bug");
  assert.equal(
    await ticketSpecHash("  Fix login \r\n", "One  \r\nTwo\r\n", "Bug "),
    clean,
  );
  assert.notEqual(await ticketSpecHash("Fix logout", "One\nTwo", "Bug"), clean);
  assert.notEqual(await ticketSpecHash("Fix login", "One\nTwo", "Task"), clean);
});

test("keeps fields apart so text cannot move between them", async () => {
  assert.notEqual(
    await ticketSpecHash("a", "b c", "Task"),
    await ticketSpecHash("a b", "c", "Task"),
  );
});

test("normalizes only whitespace at line ends and around the text", () => {
  assert.equal(normalizeSpecText("\r\n a  \r b\t\n"), "a\n b");
});

test("names a ticket by its Jira key while it has one", () => {
  assert.equal(ticketKey({ number: 12 }), "T-12");
  assert.equal(ticketKey({ number: 12, jiraKey: null }), "T-12");
  assert.equal(ticketKey({ number: 12, jiraKey: "APP-4" }), "APP-4");
});

test("declares a ticket's origins, bounds and default type", () => {
  assert.deepEqual([...TICKET_ORIGINS], ["manual", "jira"]);
  assert.equal(TICKET_LIMITS.description, 20_000);
  assert.equal(DEFAULT_ISSUE_TYPE, "Task");
  assert.ok(BOUNTY_RUN_KINDS.includes("ticket"));
  // A ticket id is private provenance, like the pointers it replaced.
  assert.ok(DESCRIPTOR_FORBIDDEN_KEYS.includes("ticketIds"));
});
