import assert from "node:assert/strict";
import { test } from "node:test";

import { adfToText } from "../src/adf.js";

/** A document wrapper, since every real description is one. */
function doc(...content: unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

function paragraph(...text: string[]): unknown {
  return {
    type: "paragraph",
    content: text.map((value) => ({ type: "text", text: value })),
  };
}

test("a plain paragraph becomes its text", () => {
  assert.equal(adfToText(doc(paragraph("Ship the thing."))), "Ship the thing.");
});

test("paragraphs are separated by a blank line", () => {
  assert.equal(
    adfToText(doc(paragraph("First."), paragraph("Second."))),
    "First.\n\nSecond.",
  );
});

test("text runs within a paragraph join without a gap", () => {
  // Jira splits a sentence into runs wherever formatting changes, so a bolded
  // word mid-sentence arrives as three runs of one paragraph.
  assert.equal(
    adfToText(doc(paragraph("The ", "important", " part."))),
    "The important part.",
  );
});

test("headings keep their level as Markdown", () => {
  // The model reads these as structure; flattened to bare text a heading is
  // indistinguishable from a sentence.
  const document = doc(
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Acceptance criteria" }],
    },
    paragraph("It works."),
  );

  assert.equal(adfToText(document), "## Acceptance criteria\n\nIt works.");
});

test("a heading level outside 1-6 is clamped rather than repeated", () => {
  const document = doc({
    type: "heading",
    attrs: { level: 99 },
    content: [{ type: "text", text: "Deep" }],
  });

  assert.equal(adfToText(document), "###### Deep");
});

test("a bullet list keeps one item per line", () => {
  // Acceptance criteria are usually a bullet list. Flattening one into a
  // run-on paragraph is how a ticket loses the thing that made it sizable.
  const document = doc({
    type: "bulletList",
    content: [
      { type: "listItem", content: [paragraph("Reads the board.")] },
      { type: "listItem", content: [paragraph("Prices each ticket.")] },
    ],
  });

  assert.equal(
    adfToText(document),
    "- Reads the board.\n\n- Prices each ticket.",
  );
});

test("an ordered list numbers from its start attribute", () => {
  const document = doc({
    type: "orderedList",
    attrs: { order: 3 },
    content: [
      { type: "listItem", content: [paragraph("Third.")] },
      { type: "listItem", content: [paragraph("Fourth.")] },
    ],
  });

  assert.equal(adfToText(document), "3. Third.\n\n4. Fourth.");
});

test("a task list records whether each box is ticked", () => {
  // Whether a box is ticked is exactly what says how much work is left.
  const document = doc({
    type: "taskList",
    content: [
      {
        type: "taskItem",
        attrs: { state: "DONE" },
        content: [{ type: "text", text: "Schema" }],
      },
      {
        type: "taskItem",
        attrs: { state: "TODO" },
        content: [{ type: "text", text: "Routes" }],
      },
    ],
  });

  assert.equal(adfToText(document), "- [x] Schema\n\n- [ ] Routes");
});

test("a code block keeps its fence and language", () => {
  const document = doc({
    type: "codeBlock",
    attrs: { language: "sql" },
    content: [{ type: "text", text: "select 1;" }],
  });

  assert.equal(adfToText(document), "```sql\nselect 1;\n```");
});

test("a table becomes a GFM table, header delimiter and all", () => {
  const cell = (text: string) => ({
    type: "tableCell",
    content: [paragraph(text)],
  });
  const document = doc({
    type: "table",
    content: [
      { type: "tableRow", content: [cell("Field"), cell("Value")] },
      { type: "tableRow", content: [cell("Retries"), cell("3")] },
    ],
  });

  // One block, single-newline separated, with the delimiter row GFM needs.
  // Joined with a blank line instead, these would be stray paragraphs that
  // merely begin with a pipe — which is how they rendered before.
  assert.equal(
    adfToText(document),
    "| Field | Value |\n| --- | --- |\n| Retries | 3 |",
  );
});

test("a mention keeps its label rather than vanishing", () => {
  // "assign to @Ada" loses its meaning if the mention flattens to nothing.
  const document = doc({
    type: "paragraph",
    content: [
      { type: "text", text: "Ask " },
      { type: "mention", attrs: { id: "557058:x", text: "@Ada" } },
      { type: "text", text: " first." },
    ],
  });

  assert.equal(adfToText(document), "Ask @Ada first.");
});

test("a mention with no label degrades to a placeholder", () => {
  const document = doc({
    type: "paragraph",
    content: [{ type: "mention", attrs: { id: "557058:x" } }],
  });

  assert.equal(adfToText(document), "@unknown");
});

test("an inline card contributes its URL", () => {
  // A linked issue: the URL is the only text there is, and it often names the
  // related ticket.
  const document = doc({
    type: "paragraph",
    content: [
      { type: "text", text: "Blocked by " },
      {
        type: "inlineCard",
        attrs: { url: "https://acme.atlassian.net/browse/ACME-9" },
      },
    ],
  });

  assert.equal(
    adfToText(document),
    "Blocked by https://acme.atlassian.net/browse/ACME-9",
  );
});

test("a hard break becomes a newline inside the paragraph", () => {
  const document = doc({
    type: "paragraph",
    content: [
      { type: "text", text: "One" },
      { type: "hardBreak" },
      { type: "text", text: "Two" },
    ],
  });

  assert.equal(adfToText(document), "One\nTwo");
});

test("a blockquote is marked as quoted", () => {
  const document = doc({
    type: "blockquote",
    content: [paragraph("The client said no.")],
  });

  assert.equal(adfToText(document), "> The client said no.");
});

test("a horizontal rule survives as a separator", () => {
  assert.equal(adfToText(doc({ type: "rule" })), "---");
});

test("media is named rather than fetched", () => {
  // Attachments are not read: the spec is the text. Naming them keeps "there
  // is a screenshot here" visible.
  const document = doc({
    type: "mediaSingle",
    content: [{ type: "media", attrs: { id: "abc", type: "file" } }],
  });

  assert.equal(adfToText(document), "[media]");
});

/*
 * Everything below is about not failing. A description is untrusted input from
 * a system that adds node types on its own schedule, and one unreadable
 * ticket must never fail a whole run.
 */

test("an unknown node type contributes its children rather than throwing", () => {
  // The property that matters most: a node type Atlassian adds after this was
  // written must not turn a new feature into an outage for the board.
  const document = doc({
    type: "someNodeInventedLater",
    content: [paragraph("Still readable.")],
  });

  assert.equal(adfToText(document), "Still readable.");
});

test("a panel's contents survive even though panels are not special-cased", () => {
  const document = doc({
    type: "panel",
    attrs: { panelType: "warning" },
    content: [paragraph("Careful.")],
  });

  assert.equal(adfToText(document), "Careful.");
});

test("a null or missing description is empty, not an error", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText(undefined), "");
});

test("a pre-ADF string description is accepted as-is", () => {
  // A site still on the old wiki-markup renderer sends a plain string.
  assert.equal(adfToText("Just text."), "Just text.");
});

test("a malformed document does not throw", () => {
  // Every one of these is a shape the type says cannot happen.
  assert.equal(adfToText({ type: "doc", content: "not an array" }), "");
  assert.equal(adfToText({ type: "doc", content: [null, 42, "x"] }), "");
  assert.equal(adfToText({ content: [paragraph("No type.")] }), "No type.");
  assert.equal(adfToText([]), "");
  assert.equal(adfToText(42), "");
});

test("a text node with a non-string text is skipped", () => {
  const document = doc({
    type: "paragraph",
    content: [{ type: "text", text: { nested: true } }],
  });

  assert.equal(adfToText(document), "");
});

test("deeply nested content is bounded rather than overflowing the stack", () => {
  // Hostile or malformed input: without the depth guard this recurses until
  // the stack gives out, which takes the whole process with it.
  let node: unknown = paragraph("Bottom.");
  for (let i = 0; i < 5_000; i += 1) {
    node = { type: "blockquote", content: [node] };
  }

  // The assertion is that it returns at all.
  assert.equal(typeof adfToText(doc(node)), "string");
});

test("output is capped, and says so when it truncates", () => {
  const long = "x".repeat(50_000);
  const result = adfToText(doc(paragraph(long)));

  assert.ok(result.length < 21_000, `got ${result.length} characters`);
  assert.match(result, /\[truncated\]$/);
});

test("a very long document is flattened in linear time", () => {
  // 20,000 paragraphs is not a realistic ticket, but it is cheap insurance
  // against an accidentally quadratic join.
  const paragraphs = Array.from({ length: 20_000 }, (_, index) =>
    paragraph(`Line ${index}.`),
  );

  const started = Date.now();
  adfToText(doc(...paragraphs));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `took ${elapsed}ms`);
});

test("a malformed table row or cell is skipped, not fatal", () => {
  // Same guarantee as everywhere else: one unreadable ticket must not fail a
  // whole run, and these are shapes the type says cannot happen.
  const document = doc({
    type: "table",
    content: [
      null,
      "not a row",
      {
        type: "tableRow",
        content: [null, { type: "tableCell", content: [paragraph("Kept")] }],
      },
    ],
  });

  assert.equal(adfToText(document), "| Kept |\n| --- |");
});

test("several attachments are counted rather than listed", () => {
  const document = doc({
    type: "mediaGroup",
    content: [
      { type: "media", attrs: { id: "a" } },
      { type: "media", attrs: { id: "b" } },
    ],
  });

  assert.equal(adfToText(document), "[media x2]");
});

test("a bare text node outside a paragraph still contributes", () => {
  // Reached through the default branch: some generators emit loose text.
  assert.equal(adfToText(doc({ type: "text", text: "Loose." })), "Loose.");
});

test("an emoji contributes its shortname, or nothing when unnamed", () => {
  const named = doc({
    type: "paragraph",
    content: [
      { type: "text", text: "Ship it " },
      { type: "emoji", attrs: { shortName: ":rocket:" } },
    ],
  });
  assert.equal(adfToText(named), "Ship it :rocket:");

  const unnamed = doc({
    type: "paragraph",
    content: [{ type: "emoji", attrs: {} }],
  });
  assert.equal(adfToText(unnamed), "");
});

test("an inline date contributes its timestamp", () => {
  // A due date written into the description is part of the spec.
  const document = doc({
    type: "paragraph",
    content: [
      { type: "text", text: "Due " },
      { type: "date", attrs: { timestamp: "1758326400000" } },
    ],
  });

  assert.equal(adfToText(document), "Due 1758326400000");
});

test("an inline card with no URL contributes nothing", () => {
  const document = doc({
    type: "paragraph",
    content: [{ type: "inlineCard", attrs: {} }],
  });

  assert.equal(adfToText(document), "");
});

test("inline nesting is bounded as well as block nesting", () => {
  // The same guard, on the other recursion: formatting marks nest, and a
  // hostile document can nest them as deeply as it likes.
  let node: unknown = { type: "text", text: "deep" };
  for (let i = 0; i < 5_000; i += 1) {
    node = { type: "someInlineWrapper", content: [node] };
  }

  assert.equal(
    typeof adfToText(doc({ type: "paragraph", content: [node] })),
    "string",
  );
});
