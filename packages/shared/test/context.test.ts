import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvedTaskSnapshotSchema,
  bountyContextResponseSchema,
  bountyDtoSchema,
  syncBountyContextResponseSchema,
} from "../src/index.js";

const stamp = "2026-10-07T00:00:00.000Z";

const detail = {
  id: "bty_1",
  organizationId: "org_1",
  title: "Invitations are not sent",
  origin: "manual",
  stack: [],
  revision: 1,
  version: 1,
  approval: null,
  jira: null,
  proposal: null,
  sandbox: null,
  createdAt: stamp,
  updatedAt: stamp,
  description: "Steps",
  components: [],
  inputTruncated: false,
  createdBy: null,
};

const jiraVersion = {
  source: "jira",
  version: 2,
  ref: "ACME-1",
  revision: "2026-10-06T00:00:00.000+0000",
  syncedBy: "user_1",
  createdAt: stamp,
  checkedAt: stamp,
  content: {
    key: "ACME-1",
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    priority: "High",
    labels: [],
    components: [],
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: 3,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [{ type: "Blocks", direction: "inward", key: null, done: false }],
    updated: null,
  },
};

const unlinked = {
  state: "unlinked",
  reason: null,
  linked: null,
  liveRevision: null,
  latest: null,
};

test("stages from an answer without context read as having none", () => {
  const parsed = bountyDtoSchema.parse({
    ...detail,
    stages: {
      scope: { version: 1 },
      price: { version: 0, scopeVersion: 1 },
      sandbox: { version: 1, priceVersion: null },
    },
  });
  const none = { jira: null, github: null };
  assert.deepEqual(parsed.stages.scope.context, none);
  assert.deepEqual(parsed.stages.price?.context, none);
  assert.deepEqual(parsed.stages.sandbox?.context, none);
});

test("each step carries the context versions it was made with", () => {
  const parsed = bountyDtoSchema.parse({
    ...detail,
    stages: {
      scope: { version: 1, context: { jira: 2, github: 1 } },
      price: {
        version: 1,
        scopeVersion: 1,
        context: { jira: 1, github: null },
      },
      sandbox: null,
    },
  });
  assert.deepEqual(parsed.stages.price?.context, { jira: 1, github: null });
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      stages: {
        scope: { version: 1, context: { jira: 0, github: null } },
        price: null,
        sandbox: null,
      },
    }).success,
    false,
  );
});

test("a source's status names its state and the version it holds", () => {
  const parsed = bountyContextResponseSchema.parse({
    jira: {
      state: "ahead",
      reason: null,
      linked: {
        ref: "ACME-1",
        url: "https://acme.atlassian.net/browse/ACME-1",
      },
      liveRevision: "2026-10-07T00:00:00.000+0000",
      latest: jiraVersion,
    },
    github: unlinked,
  });
  assert.equal(parsed.jira.latest?.source, "jira");
  assert.equal(
    bountyContextResponseSchema.safeParse({
      jira: { ...unlinked, state: "stale" },
      github: unlinked,
    }).success,
    false,
  );
  // A version's content is its source's.
  assert.equal(
    bountyContextResponseSchema.safeParse({
      jira: { ...unlinked, latest: { ...jiraVersion, source: "github" } },
      github: unlinked,
    }).success,
    false,
  );
});

test("a GitHub version reads the workspace's repositories, or the one an older sync read", () => {
  const repository = {
    fullName: "acme/app",
    branch: "main",
    commitSha: "abc",
    documents: [
      { path: "README.md", bytes: 5, text: "Hello", truncated: false },
    ],
    omitted: 0,
  };
  const githubVersion = {
    ...jiraVersion,
    source: "github",
    ref: "2 repositories",
    revision: "acme/app@abc\nacme/web@def",
    content: {
      repositories: [repository, { ...repository, fullName: "acme/web" }],
      unread: ["acme/new"],
    },
  };
  const status = {
    state: "current",
    reason: null,
    // Several repositories have no one place to be found.
    linked: { ref: "2 repositories", url: null },
    liveRevision: githubVersion.revision,
    latest: githubVersion,
  };
  const parsed = bountyContextResponseSchema.parse({
    jira: unlinked,
    github: status,
  });
  assert.deepEqual(parsed.github.latest?.content, githubVersion.content);
  // Kept in the shape it was synced in.
  const legacy = bountyContextResponseSchema.parse({
    jira: unlinked,
    github: { ...status, latest: { ...githubVersion, content: repository } },
  });
  assert.deepEqual(legacy.github.latest?.content, repository);
  assert.equal(
    bountyContextResponseSchema.safeParse({
      jira: unlinked,
      github: {
        ...status,
        latest: {
          ...githubVersion,
          content: { repositories: [repository] },
        },
      },
    }).success,
    false,
  );
});

test("a sync answers with the bounty, both sources and whether it changed", () => {
  assert.equal(
    syncBountyContextResponseSchema.safeParse({
      bounty: {
        ...detail,
        stages: { scope: { version: 1 }, price: null, sandbox: null },
      },
      context: { jira: unlinked, github: unlinked },
      changed: true,
    }).success,
    true,
  );
});

test("a frozen task carries its context, or none when frozen before it was kept", () => {
  const task = {
    schemaVersion: 3,
    title: "T",
    summary: "S",
    spec: null,
    pricing: null,
    selectedBy: "user_1",
    selectedAt: stamp,
    bountyId: "bty_1",
  };
  assert.equal(approvedTaskSnapshotSchema.safeParse(task).success, true);
  assert.equal(
    approvedTaskSnapshotSchema.safeParse({
      ...task,
      context: {
        jira: { version: 2, content: jiraVersion.content },
        github: null,
      },
    }).success,
    true,
  );
});
