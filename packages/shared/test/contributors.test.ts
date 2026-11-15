import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimInviteSchema,
  CONTRIBUTOR_INVITE_DEFAULT_DAYS,
  contributionDtoSchema,
  contributionSubmissionDtoSchema,
  contributorListResponseSchema,
  createContributorInviteSchema,
  createdContributorInviteResponseSchema,
  submissionDtoSchema,
} from "../src/index.js";

const stamp = "2026-11-15T00:00:00.000Z";

test("an invite defaults to fourteen days and one claim, within bounds", () => {
  assert.deepEqual(createContributorInviteSchema.parse({}), {
    expiresInDays: CONTRIBUTOR_INVITE_DEFAULT_DAYS,
    maxClaims: 1,
  });
  assert.deepEqual(
    createContributorInviteSchema.parse({
      label: " Grace ",
      email: "grace@example.test",
      expiresInDays: 30,
      maxClaims: 20,
    }),
    {
      label: "Grace",
      email: "grace@example.test",
      expiresInDays: 30,
      maxClaims: 20,
    },
  );
  for (const bad of [
    { expiresInDays: 0 },
    { expiresInDays: 31 },
    { maxClaims: 0 },
    { maxClaims: 21 },
    { email: "not an address" },
    { label: "" },
    { organizationId: "org_1" },
  ])
    assert.equal(
      createContributorInviteSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  // The secret is a body field, bounded.
  assert.equal(claimInviteSchema.safeParse({ token: "x" }).success, true);
  assert.equal(claimInviteSchema.safeParse({ token: "" }).success, false);
  assert.equal(
    claimInviteSchema.safeParse({ token: "x".repeat(201) }).success,
    false,
  );
});

const invite = {
  id: "cin_1",
  sandboxVersionId: "sbv_1",
  label: "Grace",
  emailHint: null,
  state: "active",
  maxClaims: 1,
  claims: 0,
  expiresAt: stamp,
  revokedAt: null,
  claimedAt: null,
  createdBy: { id: "user_1", name: "Ada Lovelace" },
  createdAt: stamp,
};

test("the workspace's views of invites and contributors parse", () => {
  assert.equal(
    createdContributorInviteResponseSchema.parse({
      invite,
      token: "lnxinv_x",
      claimUrl: "https://app.example.test/invite#lnxinv_x",
    }).invite.state,
    "active",
  );
  const listed = contributorListResponseSchema.parse({
    invites: [invite],
    contributors: [
      {
        id: "cas_1",
        sandboxVersionId: "sbv_1",
        user: { id: "user_c", name: "Grace Hopper", email: "g@example.test" },
        inviteId: "cin_1",
        createdAt: stamp,
        revokedAt: null,
      },
    ],
  });
  assert.equal(listed.contributors.length, 1);
  assert.equal(
    contributorListResponseSchema.safeParse({
      invites: [{ ...invite, state: "used" }],
      contributors: [],
    }).success,
    false,
  );
});

const submission = {
  id: "sbm_1",
  sandboxVersionId: "sbv_1",
  status: "failed",
  errorCode: null,
  verdict: "overfit",
  public: { passed: 2, total: 2 },
  hidden: { passed: 2, total: 3 },
  failedScenarios: ["s3"],
  refused: [],
  retryOf: null,
  createdAt: stamp,
  updatedAt: stamp,
};

test("a contributor's submission carries no run, carry-back, merge or contributor", () => {
  assert.deepEqual(contributionSubmissionDtoSchema.parse(submission), {
    ...submission,
  });
  for (const extra of [
    { runId: "arn_1" },
    { merge: null },
    { carryBack: null },
    { contributor: null },
  ])
    assert.equal(
      contributionSubmissionDtoSchema.safeParse({ ...submission, ...extra })
        .success,
      false,
      JSON.stringify(extra),
    );
  // The workspace's view names its contributor, and reads an older API.
  const owners = submissionDtoSchema.parse({
    ...submission,
    runId: null,
    merge: null,
  });
  assert.equal(owners.contributor, null);
  assert.equal(
    submissionDtoSchema.parse({
      ...submission,
      runId: null,
      merge: null,
      contributor: {
        assignmentId: "cas_1",
        userId: "user_c",
        name: "Grace Hopper",
        email: "g@example.test",
      },
    }).contributor?.name,
    "Grace Hopper",
  );
  assert.equal(
    contributionDtoSchema.parse({
      assignmentId: "cas_1",
      versionId: "sbv_1",
      version: 1,
      root: "sbx_1-v1",
      title: null,
      specSummary: null,
      complexity: null,
      tags: [],
      open: true,
      closesAt: stamp,
      joinedAt: stamp,
    }).open,
    true,
  );
});
