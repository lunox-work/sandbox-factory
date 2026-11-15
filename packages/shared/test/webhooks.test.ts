import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWebhookSchema,
  githubCiSignalEventSchema,
  mergeBackStatusSchema,
  mergeSubmissionSchema,
  submissionDtoSchema,
  submissionFilesResponseSchema,
  updateWebhookSchema,
  WEBHOOK_EVENT_DATA_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  webhookEventSchema,
} from "../src/index.js";

test("an endpoint names an http(s) URL and each event type once", () => {
  const parsed = createWebhookSchema.parse({
    url: "https://hooks.example.test/lunox",
    eventTypes: ["run.finished", "proposal.priced"],
  });
  assert.equal(parsed.description, "");
  for (const body of [
    { url: "ftp://hooks.example.test", eventTypes: ["run.finished"] },
    { url: "https://hooks.example.test", eventTypes: [] },
    {
      url: "https://hooks.example.test",
      eventTypes: ["run.finished", "run.finished"],
    },
    { url: "https://hooks.example.test", eventTypes: ["ping"] },
  ])
    assert.equal(createWebhookSchema.safeParse(body).success, false);
});

test("a change names something, and an event carries ids and states", () => {
  assert.equal(updateWebhookSchema.safeParse({}).success, false);
  assert.equal(updateWebhookSchema.safeParse({ enabled: true }).success, true);
  assert.equal(
    webhookEventSchema.safeParse({
      id: "evt_1",
      type: "ping",
      createdAt: "2026-11-12T00:00:00.000Z",
      organizationId: "org_1",
      data: {},
    }).success,
    true,
  );
});

const pullRequest = {
  submissionId: "sbm_1",
  sandboxVersionId: "sbv_1",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/shop/pull/7",
};

test("the submission events are endpoint event types, each with the data it carries and nothing else", () => {
  for (const type of Object.keys(WEBHOOK_EVENT_DATA_SCHEMAS))
    assert.ok((WEBHOOK_EVENT_TYPES as readonly string[]).includes(type), type);
  assert.equal(
    createWebhookSchema.safeParse({
      url: "https://hooks.example.test/lunox",
      eventTypes: ["submission.graded", "submission.merged"],
    }).success,
    true,
  );
  const graded = {
    submissionId: "sbm_1",
    sandboxVersionId: "sbv_1",
    runId: "arn_1",
    status: "passed",
    verdict: "passed",
    public: { passed: 3, total: 3 },
    hidden: { passed: 2, total: 2 },
    carryBack: null,
  };
  const schemas = WEBHOOK_EVENT_DATA_SCHEMAS;
  assert.equal(schemas["submission.graded"].safeParse(graded).success, true);
  // Never a scenario key or a hidden test's name.
  assert.equal(
    schemas["submission.graded"].safeParse({
      ...graded,
      failedScenarios: ["s1"],
    }).success,
    false,
  );
  assert.equal(
    schemas["submission.merge_opened"].safeParse({
      ...pullRequest,
      when: "ci_passes",
    }).success,
    true,
  );
  assert.equal(
    schemas["submission.ci"].safeParse({
      ...pullRequest,
      state: "failing",
      headSha: "beef",
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
    }).success,
    true,
  );
  assert.equal(
    schemas["submission.merged"].safeParse({
      ...pullRequest,
      mergedCommitSha: null,
      by: "github",
    }).success,
    true,
  );
  assert.equal(
    schemas["submission.merged"].safeParse({ ...pullRequest, by: "bot" })
      .success,
    false,
  );
});

test("a merge body is empty or names when; a merge read from an older API reads as opened alone with CI pending", () => {
  assert.deepEqual(mergeSubmissionSchema.parse({}), { when: "open" });
  assert.deepEqual(mergeSubmissionSchema.parse({ when: "ci_passes" }), {
    when: "ci_passes",
  });
  assert.equal(mergeSubmissionSchema.safeParse({ when: "now" }).success, false);
  const submission = {
    id: "sbm_1",
    sandboxVersionId: "sbv_1",
    status: "passed",
    verdict: "passed",
    public: { passed: 1, total: 1 },
    hidden: { passed: 1, total: 1 },
    failedScenarios: [],
    refused: [],
    runId: "arn_1",
    retryOf: null,
    merge: {
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/acme/shop/pull/7",
      branch: "lunox/sbm_1",
      createdAt: "2026-11-15T00:00:00.000Z",
    },
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
  const parsed = submissionDtoSchema.parse(submission);
  assert.deepEqual(parsed.merge, {
    ...submission.merge,
    when: "open",
    pullRequestState: "open",
    ci: { state: "pending", summary: null, headSha: null, checkedAt: null },
    mergedCommitSha: null,
    mergedAt: null,
    mergeError: null,
  });
  assert.deepEqual(
    mergeBackStatusSchema.parse({
      code: null,
      error: null,
      missing: [],
      acceptUrl: null,
    }).ciMissing,
    [],
  );
  // Files taken back: an older API's answer was an upload's.
  assert.equal(
    submissionFilesResponseSchema.parse({
      submission,
      upload: { recordSha256: "r", carveoutVersion: "0.4.0" },
      files: [],
    }).origin,
    "upload",
  );
});

test("a CI delivery is read for what names a pull request, whichever event it is", () => {
  const parsed = githubCiSignalEventSchema.parse({
    action: "completed",
    check_suite: {
      head_sha: "beef",
      head_branch: null,
      pull_requests: [{ number: 7, url: "x" }],
    },
    repository: { id: 1, full_name: "acme/shop", private: true },
    installation: { id: 9 },
  });
  assert.equal(parsed.check_suite?.head_branch, null);
  assert.equal(parsed.check_suite?.pull_requests?.[0]?.number, 7);
  assert.equal(
    githubCiSignalEventSchema.safeParse({ sha: "beef" }).success,
    false,
  );
});
