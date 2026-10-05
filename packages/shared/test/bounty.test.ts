import assert from "node:assert/strict";
import { test } from "node:test";

import * as core from "sandbox-factory";

import {
  createSandboxSchema,
  createBountySchema,
  proposeBountySchema,
  bountyDtoSchema,
  bountyListResponseSchema,
  BOUNTY_LIMITS,
  bountySpecHash,
  linkSandboxSourceSchema,
  sandboxDtoSchema,
  updateBountySchema,
} from "../src/index.js";

const stamp = "2026-10-03T00:00:00.000Z";

const summary = {
  id: "bty_1",
  organizationId: "org_1",
  title: "Invitations are not sent",
  origin: "manual",
  repoId: null,
  stack: ["Zod"],
  revision: 1,
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
    repoId: null,
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

test("a change names its revision and at least one field", () => {
  assert.equal(
    updateBountySchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
  assert.deepEqual(
    updateBountySchema.parse({ expectedRevision: 2, repoId: null }),
    { expectedRevision: 2, repoId: null },
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
  // A Jira bounty's stack is the workspace's to set, like its repository.
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
  };
  assert.equal(bountyDtoSchema.safeParse(detail).success, true);
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
        sourceRepoId: "ghr_1",
      },
    }).success,
    true,
  );
  // A sandbox made without a repository says so, rather than leaving it out.
  const bare = {
    id: "sbx_1",
    status: "draft",
    currentVersionId: null,
    sourceRepoId: null,
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
        sourceRepoId: null,
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

test("a sandbox belongs to one bounty, with or without a repository", () => {
  assert.deepEqual(createSandboxSchema.parse({ bountyId: "bty_1" }), {
    bountyId: "bty_1",
    sourceRepoId: null,
  });
  assert.deepEqual(
    createSandboxSchema.parse({ bountyId: "bty_1", sourceRepoId: "ghr_1" }),
    { bountyId: "bty_1", sourceRepoId: "ghr_1" },
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
  // One made without a repository reads back as one, and links one later.
  assert.equal(
    sandboxDtoSchema.parse({
      id: "sbx_1",
      slug: "abc123def456",
      status: "draft",
      publicRepoId: null,
      currentVersionId: null,
      bountyId: "bty_1",
      sourceRepoId: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    }).sourceRepoId,
    null,
  );
  assert.deepEqual(linkSandboxSourceSchema.parse({ sourceRepoId: "ghr_1" }), {
    sourceRepoId: "ghr_1",
  });
  for (const body of [{}, { sourceRepoId: "" }, { sourceRepoId: null }])
    assert.equal(linkSandboxSourceSchema.safeParse(body).success, false);
});

test("re-exports the one bounty hash and bounds, not copies", async () => {
  assert.equal(bountySpecHash, core.bountySpecHash);
  assert.equal(BOUNTY_LIMITS, core.BOUNTY_LIMITS);
  assert.equal((await bountySpecHash("a", "b")).length, 64);
});
