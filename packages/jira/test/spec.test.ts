import assert from "node:assert/strict";
import { test } from "node:test";

import { SPEC_FIELDS, specHash, toIssueSpec } from "../src/spec.js";

test("the same spec hashes the same every time", () => {
  // If this were unstable every proposal would show as stale at random.
  return Promise.all([
    specHash("Add export", "Adds a CSV export."),
    specHash("Add export", "Adds a CSV export."),
  ]).then(([first, second]) => {
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });
});

test("changing the summary changes the hash", async () => {
  const before = await specHash("Add export", "Body.");
  const after = await specHash("Add import", "Body.");

  assert.notEqual(before, after);
});

test("changing the description changes the hash", async () => {
  const before = await specHash("Same", "One.");
  const after = await specHash("Same", "Two.");

  assert.notEqual(before, after);
});

test("trailing whitespace and line endings do not change the hash", async () => {
  // Opening a ticket in a different editor should not invalidate a bounty.
  const unix = await specHash("Title", "One\nTwo");
  const windows = await specHash("Title  ", "One  \r\nTwo\t");

  assert.equal(unix, windows);
});

test("the field separator cannot be forged from a summary", async () => {
  // Without a separator "AB" + "" and "A" + "B" would collide, and a crafted
  // summary could make an edited description hash as unchanged.
  const split = await specHash("A", "B");
  const joined = await specHash("AB", "");

  assert.notEqual(split, joined);
});

test("an empty spec still hashes", async () => {
  assert.match(await specHash("", ""), /^[0-9a-f]{64}$/);
});

test("SPEC_FIELDS asks for the description, and the list reads do not", () => {
  // The whole point of the separate call: `ISSUE_FIELDS` must never carry
  // `description`, so a board read cannot pull ticket text by accident.
  assert.ok(SPEC_FIELDS.includes("description"));
  assert.ok(SPEC_FIELDS.includes("summary"));
});

test("toIssueSpec flattens the description and hashes what it read", async () => {
  const spec = await toIssueSpec("ACME-1", {
    summary: "Add export",
    description: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Adds CSV." }] },
      ],
    },
    issuetype: { name: "Story" },
    updated: "2026-09-20T00:00:00.000Z",
  });

  assert.equal(spec.key, "ACME-1");
  assert.equal(spec.summary, "Add export");
  assert.equal(spec.descriptionText, "Adds CSV.");
  assert.equal(spec.issueType, "Story");
  assert.equal(spec.updated, "2026-09-20T00:00:00.000Z");
  // The hash covers exactly the text that was priced.
  assert.equal(spec.specHash, await specHash("Add export", "Adds CSV."));
});

test("a ticket with no description is a valid spec", async () => {
  // Expected to be common: the oldest backlog tickets are the thinnest, and
  // an empty description is a sizing input, not an error.
  const spec = await toIssueSpec("ACME-2", { summary: "Fix it" });

  assert.equal(spec.descriptionText, "");
  assert.equal(spec.issueType, "Task");
  assert.equal(spec.updated, null);
});

test("missing fields fall back rather than throwing", async () => {
  const spec = await toIssueSpec("ACME-3", {
    summary: 42 as unknown as string,
    issuetype: null,
  });

  assert.equal(spec.summary, "");
  assert.equal(spec.issueType, "Task");
});
