import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTEXT_DOCUMENT_CHARS,
  CONTEXT_DOCUMENTS_MAX,
  CONTEXT_TOTAL_CHARS,
  contextDocuments,
  contextDocumentsAcross,
  contextDrift,
  contextKeywords,
  githubRepositories,
  jiraContextFields,
  keptDocuments,
  keptDocumentsAligned,
  NO_CONTEXT,
  renderSourceContext,
  repositoryLabel,
  type GithubContext,
  type GithubRepositoryContext,
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

test("documents across repositories are ranked together: every README before any guide", () => {
  const { chosen, omitted } = contextDocumentsAcross([
    { files: [file("docs/setup.md"), file("README.md")] },
    { files: [file("CONTRIBUTING.md"), file("README.md")] },
  ]);
  assert.deepEqual(chosen, [
    { repository: 0, path: "README.md" },
    { repository: 1, path: "README.md" },
    { repository: 1, path: "CONTRIBUTING.md" },
    { repository: 0, path: "docs/setup.md" },
  ]);
  assert.deepEqual(omitted, [0, 0]);
  assert.deepEqual(contextDocumentsAcross([]), { chosen: [], omitted: [] });
});

test("a document naming a word of the title is read ahead, whichever repository holds it", () => {
  const { chosen } = contextDocumentsAcross(
    [
      { files: [file("docs/setup.md")] },
      { files: [file("packages/billing/README.md")] },
    ],
    contextKeywords("Retry failed billing webhooks"),
  );
  assert.deepEqual(chosen, [
    { repository: 1, path: "packages/billing/README.md" },
    { repository: 0, path: "docs/setup.md" },
  ]);
});

test("documents across repositories share one cap, and each counts what it left out", () => {
  const docs = Array.from({ length: CONTEXT_DOCUMENTS_MAX }, (_, index) =>
    file(`docs/${String(index).padStart(2, "0")}.md`),
  );
  const { chosen, omitted } = contextDocumentsAcross([
    { files: docs },
    { files: [file("README.md"), file("docs/zz.md")] },
  ]);
  assert.equal(chosen.length, CONTEXT_DOCUMENTS_MAX);
  // The second's README outranks the first's docs; its docs come after.
  assert.deepEqual(chosen[0], { repository: 1, path: "README.md" });
  assert.deepEqual(omitted, [1, 1]);
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

test("aligned, kept documents answer in the order given, null for those dropped", () => {
  const long = "x".repeat(CONTEXT_DOCUMENT_CHARS);
  const count = Math.ceil(CONTEXT_TOTAL_CHARS / CONTEXT_DOCUMENT_CHARS);
  const kept = keptDocumentsAligned([
    { path: "README.md", bytes: 3, text: "Hi\r\n" },
    { path: "blank.md", bytes: 3, text: " \n" },
    ...Array.from({ length: count }, (_, index) => ({
      path: `${index}.md`,
      bytes: long.length,
      text: long,
    })),
  ]);
  assert.equal(kept.length, count + 2);
  assert.deepEqual(kept[0], {
    path: "README.md",
    bytes: 3,
    text: "Hi",
    truncated: false,
  });
  assert.equal(kept[1], null);
  // The short README took a little of the total, so the last is cut, and
  // nothing after it would have room.
  assert.equal(kept.at(-1)?.truncated, true);
  assert.equal(
    kept.reduce((sum, document) => sum + (document?.text.length ?? 0), 0),
    CONTEXT_TOTAL_CHARS,
  );
  assert.deepEqual(keptDocumentsAligned([]), []);
});

test("a context's repositories are its own, or the one a legacy version read", () => {
  const one: GithubRepositoryContext = {
    fullName: "acme/app",
    branch: "main",
    commitSha: "abc",
    documents: [],
    omitted: 0,
  };
  assert.deepEqual(githubRepositories(one), [one]);
  const other = { ...one, fullName: "acme/web" };
  assert.deepEqual(
    githubRepositories({ repositories: [one, other], unread: ["acme/new"] }),
    [one, other],
  );
  assert.deepEqual(githubRepositories({ repositories: [], unread: [] }), []);
});

test("a repository is labelled by its place in the list, counting from one", () => {
  assert.equal(repositoryLabel(0), "Repository 1");
  assert.equal(repositoryLabel(4), "Repository 5");
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

test("several repositories render under their labels, never their names", () => {
  const repository = (
    fullName: string,
    text: string,
  ): GithubRepositoryContext => ({
    fullName,
    branch: "main",
    commitSha: "abc",
    documents:
      text === ""
        ? []
        : [{ path: "README.md", bytes: 5, text, truncated: false }],
    omitted: 0,
  });
  const github: GithubContext = {
    repositories: [
      repository("acme/app", "App docs"),
      repository("acme/empty", ""),
      repository("acme/web", "Web docs"),
    ],
    unread: ["acme/new"],
  };
  const labelled = renderSourceContext(
    { jira: null, github },
    new Map([
      ["acme/app", "Repository 1"],
      ["acme/web", "Repository 3"],
    ]),
  );
  assert.equal(
    labelled,
    [
      "Repository documents:",
      "=== Repository 1 ===",
      "--- README.md ---\nApp docs",
      "=== Repository 3 ===",
      "--- README.md ---\nWeb docs",
    ].join("\n\n"),
  );
  assert.doesNotMatch(labelled, /acme/);
  // One no outline holds (renamed, or disconnected since) never takes an
  // outline's label, which would credit its documents to that repository.
  const stale = renderSourceContext(
    { jira: null, github },
    new Map([["acme/web", "Repository 1"]]),
  );
  assert.equal(
    stale,
    [
      "Repository documents:",
      "=== Other repository 1 ===",
      "--- README.md ---\nApp docs",
      "=== Repository 1 ===",
      "--- README.md ---\nWeb docs",
    ].join("\n\n"),
  );
  // One with documents among several outlined is headed by its label too.
  assert.equal(
    renderSourceContext(
      {
        jira: null,
        github: { repositories: [repository("acme/web", "Web")], unread: [] },
      },
      new Map([
        ["acme/app", "Repository 1"],
        ["acme/web", "Repository 2"],
      ]),
    ),
    "Repository documents:\n\n=== Repository 2 ===\n\n--- README.md ---\nWeb",
  );
  // Without labels, by place among those with documents.
  const placed = renderSourceContext({ jira, github });
  assert.match(placed, /^Jira fields:/);
  assert.match(placed, /=== Repository 1 ===\n\n--- README\.md ---\nApp docs/);
  assert.match(placed, /=== Repository 2 ===\n\n--- README\.md ---\nWeb docs/);
  assert.doesNotMatch(placed, /acme|Repository 3/);
  // One with documents renders as a single repository's always has.
  const single = renderSourceContext({
    jira: null,
    github: {
      repositories: [repository("acme/app", "App docs"), repository("b/c", "")],
      unread: [],
    },
  });
  assert.equal(single, "Repository documents:\n\n--- README.md ---\nApp docs");
  assert.equal(
    renderSourceContext({
      jira: null,
      github: { repositories: [repository("acme/app", "")], unread: [] },
    }),
    "",
  );
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
