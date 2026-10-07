import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTEXT_DOCUMENT_CHARS,
  CONTEXT_DOCUMENTS_MAX,
  CONTEXT_TOTAL_CHARS,
  contextDocuments,
  contextDrift,
  contextKeywords,
  jiraContextFields,
  keptDocuments,
  NO_CONTEXT,
  renderSourceContext,
  type GithubContext,
  type JiraContext,
} from "../src/sources.js";

const jira: JiraContext = {
  key: "ACME-12",
  issueType: "Story",
  status: "In Progress",
  statusCategory: "indeterminate",
  priority: "High",
  labels: ["billing"],
  components: [],
  fixVersions: ["2.4"],
  parentKey: "ACME-1",
  dueDate: null,
  storyPoints: 5,
  originalEstimateSeconds: 9000,
  remainingEstimateSeconds: null,
  votes: 0,
  watchers: 3,
  subtaskCount: 0,
  links: [{ type: "Blocks", direction: "inward", key: "ACME-9", done: false }],
  updated: "2026-10-01T10:00:00.000+0000",
};

const file = (path: string, size = 100) => ({ path, size });

test("documents are read root README first, then guides, docs, module READMEs and the rest", () => {
  const { paths, omitted } = contextDocuments([
    file("packages/api/notes.md"),
    file("packages/api/README.md"),
    file("docs/setup.md"),
    file("CONTRIBUTING.md"),
    file("README.md"),
  ]);
  assert.deepEqual(paths, [
    "README.md",
    "CONTRIBUTING.md",
    "docs/setup.md",
    "packages/api/README.md",
    "packages/api/notes.md",
  ]);
  assert.equal(omitted, 0);
});

test("boilerplate, vendored, .github, oversized, empty and non-markdown files are passed over", () => {
  const { paths } = contextDocuments([
    file("CHANGELOG.md"),
    file("LICENSE.md"),
    file("CODE_OF_CONDUCT.md"),
    file("node_modules/pkg/README.md"),
    file("examples/demo/README.md"),
    file(".github/PULL_REQUEST_TEMPLATE.md"),
    file("docs/huge.md", 300 * 1024),
    file("docs/empty.md", 0),
    file("src/index.ts"),
    file("docs/guide.mdx"),
  ]);
  assert.deepEqual(paths, ["docs/guide.mdx"]);
});

test("a document whose path names a word of the title is read ahead of the tier above", () => {
  const { paths } = contextDocuments(
    [file("docs/setup.md"), file("packages/billing/README.md")],
    contextKeywords("Retry failed billing webhooks"),
  );
  assert.deepEqual(paths, ["packages/billing/README.md", "docs/setup.md"]);
});

test("keywords are the title's longer words, once each", () => {
  assert.deepEqual(contextKeywords("Fix the Billing billing API page"), [
    "billing",
    "page",
  ]);
});

test("documents past the cap are counted, not kept", () => {
  const files = Array.from({ length: CONTEXT_DOCUMENTS_MAX + 3 }, (_, index) =>
    file(`docs/${String(index).padStart(2, "0")}.md`),
  );
  const { paths, omitted } = contextDocuments(files);
  assert.equal(paths.length, CONTEXT_DOCUMENTS_MAX);
  assert.equal(omitted, 3);
});

test("kept documents are cut to their own cap and to the total", () => {
  const long = "x".repeat(CONTEXT_DOCUMENT_CHARS + 10);
  const count = Math.ceil(CONTEXT_TOTAL_CHARS / CONTEXT_DOCUMENT_CHARS) + 1;
  const { documents, omitted } = keptDocuments([
    { path: "blank.md", bytes: 3, text: "  \r\n" },
    ...Array.from({ length: count }, (_, index) => ({
      path: `${index}.md`,
      bytes: long.length,
      text: long,
    })),
  ]);
  assert.equal(documents[0]?.text.length, CONTEXT_DOCUMENT_CHARS);
  assert.equal(documents[0]?.truncated, true);
  assert.equal(
    documents.reduce((sum, { text }) => sum + text.length, 0),
    CONTEXT_TOTAL_CHARS,
  );
  // The blank one, and the one left with no room.
  assert.equal(omitted, 2);
});

test("line endings are normalized and a short document is kept whole", () => {
  const { documents } = keptDocuments([
    { path: "README.md", bytes: 9, text: "# A\r\nb\r\n" },
  ]);
  assert.deepEqual(documents, [
    { path: "README.md", bytes: 9, text: "# A\nb", truncated: false },
  ]);
});

test("Jira's fields leave out what is unset and every key and name", () => {
  assert.deepEqual(jiraContextFields(jira), {
    issueType: "Story",
    status: "In Progress",
    priority: "High",
    labels: ["billing"],
    fixVersions: ["2.4"],
    storyPoints: 5,
    originalEstimateHours: 2.5,
    votes: 0,
    watchers: 3,
    hasParent: true,
    links: [{ type: "Blocks", direction: "inward", done: false }],
  });
});

test("context renders under its own headings, and as nothing when there is none", () => {
  const github: GithubContext = {
    fullName: "acme/app",
    branch: "main",
    commitSha: "abc",
    documents: [
      { path: "README.md", bytes: 5, text: "Hello", truncated: false },
      { path: "docs/a.md", bytes: 99, text: "Cut", truncated: true },
    ],
    omitted: 0,
  };
  assert.equal(renderSourceContext({ jira: null, github: null }), "");
  assert.equal(
    renderSourceContext({ jira: null, github: { ...github, documents: [] } }),
    "",
  );
  const rendered = renderSourceContext({ jira, github });
  assert.match(rendered, /^Jira fields:\n\{"issueType":"Story"/);
  assert.match(rendered, /--- README\.md ---\nHello/);
  assert.match(rendered, /--- docs\/a\.md \(cut short\) ---\nCut/);
  assert.doesNotMatch(rendered, /ACME-12|acme\/app/);
});

test("a step is behind on a source the overview holds newer context from", () => {
  assert.deepEqual(
    contextDrift({ jira: 3, github: 2 }, { jira: 2, github: 2 }),
    {
      jira: { uses: 2, current: 3 },
      github: null,
    },
  );
  assert.deepEqual(contextDrift({ jira: 1, github: null }, NO_CONTEXT), {
    jira: { uses: null, current: 1 },
    github: null,
  });
  assert.deepEqual(contextDrift(NO_CONTEXT, { jira: 4, github: 1 }), {
    jira: null,
    github: null,
  });
});
