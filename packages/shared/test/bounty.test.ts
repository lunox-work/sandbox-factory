import assert from "node:assert/strict";
import { test } from "node:test";

import * as core from "sandbox-factory";

import {
  decideBountySchema,
  createSandboxSchema,
  createBountySchema,
  proposeBountySchema,
  bountyDtoSchema,
  bountyListResponseSchema,
  BOUNTY_LIMITS,
  bountySpecHash,
  sandboxDtoSchema,
  updateBountySchema,
} from "../src/index.js";

const stamp = "2026-10-03T00:00:00.000Z";

const summary = {
  id: "bty_1",
  organizationId: "org_1",
  title: "Invitations are not sent",
  origin: "manual",
  stack: ["Zod"],
  revision: 1,
  version: 1,
  approval: null,
  jira: null,
  proposal: null,
  sandbox: null,
  createdAt: stamp,
  updatedAt: stamp,
};

test("a bounty written here needs only a title", () => {
  assert.deepEqual(createBountySchema.parse({ title: "  Fix login  " }), {
    title: "Fix login",
    description: "",
    stack: [],
  });
  assert.equal(createBountySchema.safeParse({ title: " " }).success, false);
  assert.equal(createBountySchema.safeParse({}).success, false);
});

test("a bounty written here is bounded at the description limit", () => {
  assert.equal(
    createBountySchema.safeParse({
      title: "t",
      description: "x".repeat(20_000),
    }).success,
    true,
  );
  assert.equal(
    createBountySchema.safeParse({
      title: "t",
      description: "x".repeat(20_001),
    }).success,
    false,
  );
  assert.equal(
    createBountySchema.safeParse({ title: "x".repeat(256) }).success,
    false,
  );
});

test("a tracker's type, priority and labels are not a bounty's", () => {
  for (const field of [
    { issueType: "Bug" },
    { priority: "High" },
    { labels: ["email"] },
  ]) {
    assert.equal(
      createBountySchema.safeParse({ title: "t", ...field }).success,
      false,
    );
    assert.equal(
      updateBountySchema.safeParse({ expectedRevision: 1, ...field }).success,
      false,
    );
  }
});

test("unknown fields are refused rather than dropped", () => {
  assert.equal(
    createBountySchema.safeParse({ title: "t", origin: "jira" }).success,
    false,
  );
});

test("a bounty names no repository: its work may touch any the workspace has", () => {
  for (const repoId of ["ghr_1", null]) {
    assert.equal(
      createBountySchema.safeParse({ title: "t", repoId }).success,
      false,
    );
    assert.equal(
      updateBountySchema.safeParse({ expectedRevision: 1, repoId }).success,
      false,
    );
  }
  // One listed before it named none reads without it.
  assert.equal(
    "repoId" in
      (bountyListResponseSchema.parse({
        bounties: [{ ...summary, repoId: "ghr_1" }],
        nextCursor: null,
      }).bounties[0] ?? {}),
    false,
  );
});

test("a change names its revision and at least one field", () => {
  assert.equal(
    updateBountySchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
  assert.deepEqual(
    updateBountySchema.parse({ expectedRevision: 2, description: "" }),
    { expectedRevision: 2, description: "" },
  );
  assert.equal(updateBountySchema.safeParse({ title: "t" }).success, false);
});

test("a stack is stored under the catalog's names, each once, within bounds", () => {
  assert.deepEqual(
    createBountySchema.parse({
      title: "t",
      stack: [" postgres ", "PostgreSQL", "Our billing API"],
    }).stack,
    ["PostgreSQL", "Our billing API"],
  );
  // A Jira bounty's stack is the workspace's to set.
  assert.deepEqual(
    updateBountySchema.parse({ expectedRevision: 1, stack: ["k8s"] }),
    { expectedRevision: 1, stack: ["Kubernetes"] },
  );
  for (const stack of [
    [""],
    ["x".repeat(41)],
    Array.from({ length: 31 }, (_, i) => `Tool ${i}`),
  ])
    assert.equal(
      createBountySchema.safeParse({ title: "t", stack }).success,
      false,
    );
});

test("a proposal for a bounty is named by its request id", () => {
  assert.equal(
    proposeBountySchema.safeParse({
      requestId: "8f0b4a1e-9a77-4c35-9a52-3f0f5b2d3c11",
    }).success,
    true,
  );
  assert.equal(
    proposeBountySchema.safeParse({ requestId: "x" }).success,
    false,
  );
});

test("a bounty reads with or without a Jira issue, a proposal and a sandbox", () => {
  const detail = {
    ...summary,
    description: "Steps",
    components: [],
    inputTruncated: false,
    createdBy: "user_1",
    stages: { overview: { version: 1 }, bounty: null, sandbox: null },
  };
  assert.equal(bountyDtoSchema.safeParse(detail).success, true);
  // Each step names the version of the one before it was built on, or
  // null when that is not known; a proposal never approved is version 0.
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      stages: {
        overview: { version: 4 },
        bounty: { version: 0, overviewVersion: null },
        sandbox: { version: 2, bountyVersion: null },
      },
    }).success,
    true,
  );
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      stages: { overview: { version: 0 }, bounty: null, sandbox: null },
    }).success,
    false,
  );
  // An approved overview names the version approved, by whom and when.
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      approval: { version: 1, approvedBy: null, approvedAt: stamp },
    }).success,
    true,
  );
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      approval: { version: 0, approvedBy: "user_1", approvedAt: stamp },
    }).success,
    false,
  );
  assert.deepEqual(decideBountySchema.parse({ expectedRevision: 2 }), {
    expectedRevision: 2,
  });
  assert.equal(decideBountySchema.safeParse({}).success, false);
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      origin: "jira",
      key: "APP-3",
      jira: {
        issueId: "jri_1",
        boardId: "jrb_1",
        connectionId: "jrc_1",
        key: "APP-3",
        url: "https://acme.atlassian.net/browse/APP-3",
        removedAt: null,
      },
      proposal: {
        id: "bpr_1",
        status: "proposed",
        complexity: "M",
        amountMinor: 10_500,
        currency: "USD",
      },
    }).success,
    true,
  );
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      sandbox: {
        id: "sbx_1",
        status: "published",
        currentVersionId: "sbv_1",
        expiresAt: null,
        sourceRepoId: "ghr_1",
        build: { versionId: "sbv_1", version: 1, bountyVersion: 3 },
      },
    }).success,
    true,
  );
  // A sandbox made without a repository says so, rather than leaving it out.
  const bare = {
    id: "sbx_1",
    status: "draft",
    currentVersionId: null,
    expiresAt: null,
    sourceRepoId: null,
    build: null,
  };
  assert.equal(
    bountyDtoSchema.safeParse({ ...detail, sandbox: bare }).success,
    true,
  );
  const { sourceRepoId: _unsaid, ...silent } = bare;
  assert.equal(
    bountyDtoSchema.safeParse({ ...detail, sandbox: silent }).success,
    false,
  );
  // The sandbox is said either way: absent is null, never left out.
  const { sandbox: _sandbox, ...unsaid } = detail;
  assert.equal(bountyDtoSchema.safeParse(unsaid).success, false);
  assert.equal(
    bountyDtoSchema.safeParse({
      ...detail,
      sandbox: {
        id: "sbx_1",
        status: "building",
        currentVersionId: null,
        expiresAt: null,
        sourceRepoId: null,
        build: null,
      },
    }).success,
    false,
  );
  assert.equal(
    bountyListResponseSchema.safeParse({
      bounties: [summary],
      nextCursor: null,
    }).success,
    true,
  );
});

test("a bounty's proposal names the repositories its sizing said the work touches", () => {
  const proposal = {
    id: "bpr_1",
    status: "proposed",
    complexity: "M",
    amountMinor: 10_500,
    currency: "USD",
  };
  const touched = [
    { repoId: "ghr_1", snapshotId: "rsn_1" },
    { repoId: "ghr_2", snapshotId: "rsn_2" },
  ];
  const listed = (bounty: unknown) =>
    bountyListResponseSchema.parse({ bounties: [bounty], nextCursor: null })
      .bounties[0]?.proposal;
  assert.deepEqual(
    listed({ ...summary, proposal: { ...proposal, repositories: touched } })
      ?.repositories,
    touched,
  );
  // An older API's answer, without them, touches none.
  assert.deepEqual(listed({ ...summary, proposal })?.repositories, []);
  assert.equal(
    bountyListResponseSchema.safeParse({
      bounties: [
        {
          ...summary,
          proposal: { ...proposal, repositories: [{ repoId: "ghr_1" }] },
        },
      ],
      nextCursor: null,
    }).success,
    false,
  );
});

test("a sandbox belongs to one bounty, and nobody picks its repository", () => {
  assert.deepEqual(createSandboxSchema.parse({ bountyId: "bty_1" }), {
    bountyId: "bty_1",
  });
  // Its repository is the one its bounty's sizing says the work touches.
  assert.equal(
    createSandboxSchema.safeParse({ bountyId: "bty_1", sourceRepoId: "ghr_1" })
      .success,
    false,
  );
  // No sandbox without its bounty, and no list of them.
  assert.equal(
    createSandboxSchema.safeParse({ sourceRepoId: "ghr_1" }).success,
    false,
  );
  assert.equal(
    createSandboxSchema.safeParse({ bountyId: "bty_1", bountyIds: ["bty_1"] })
      .success,
    false,
  );
  // One made without a repository reads back as one.
  assert.equal(
    sandboxDtoSchema.parse({
      id: "sbx_1",
      slug: "abc123def456",
      status: "draft",
      publicRepoId: null,
      currentVersionId: null,
      expiresAt: null,
      bountyId: "bty_1",
      sourceRepoId: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    }).sourceRepoId,
    null,
  );
});

test("re-exports the one bounty hash and bounds, not copies", async () => {
  assert.equal(bountySpecHash, core.bountySpecHash);
  assert.equal(BOUNTY_LIMITS, core.BOUNTY_LIMITS);
  assert.equal((await bountySpecHash("a", "b")).length, 64);
});
