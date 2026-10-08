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
  repoId: null,
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
      overview: { version: 1 },
      bounty: { version: 0, overviewVersion: 1 },
      sandbox: { version: 1, bountyVersion: null },
    },
  });
  const none = { jira: null, github: null };
  assert.deepEqual(parsed.stages.overview.context, none);
  assert.deepEqual(parsed.stages.bounty?.context, none);
  assert.deepEqual(parsed.stages.sandbox?.context, none);
});

test("each step carries the context versions it was made with", () => {
  const parsed = bountyDtoSchema.parse({
    ...detail,
    stages: {
      overview: { version: 1, context: { jira: 2, github: 1 } },
      bounty: {
        version: 1,
        overviewVersion: 1,
        context: { jira: 1, github: null },
      },
      sandbox: null,
    },
  });
  assert.deepEqual(parsed.stages.bounty?.context, { jira: 1, github: null });
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      stages: {
        overview: { version: 1, context: { jira: 0, github: null } },
        bounty: null,
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

test("a sync answers with the bounty, both sources and whether it changed", () => {
  assert.equal(
    syncBountyContextResponseSchema.safeParse({
      bounty: {
        ...detail,
        stages: { overview: { version: 1 }, bounty: null, sandbox: null },
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
