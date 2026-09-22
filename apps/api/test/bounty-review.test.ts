import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoredBountyProposal } from "@sandbox-factory/db";
import { JiraApiError } from "@sandbox-factory/jira";

import { freshProposal, mapConcurrent } from "../src/bounty/review.js";

function proposal(
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    jiraIssueId: "jri_1",
    issueKey: "APP-1",
    specHash: "a".repeat(64),
    specHashVersion: 1,
    rateCard: {
      currency: "USD",
      xsMinor: 1,
      sMinor: 1,
      mMinor: 2,
      lMinor: 3,
      xlMinor: 4,
      revision: 1,
    },
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "reason",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 2,
    currency: "USD",
    status: "proposed",
    revision: 1,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    replacesProposalId: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function options(answer: unknown) {
  const removed: string[] = [];
  return {
    removed,
    value: {
      proposals: {} as never,
      issues: {
        get: () =>
          Promise.resolve({ id: "jri_1", boardId: "jrb_1", externalId: "100" }),
        markRemoved: (_o: string, id: string) => {
          removed.push(id);
          return Promise.resolve(true);
        },
      } as never,
      boards: {
        forRun: () =>
          Promise.resolve({
            connectionId: "jrc_1",
            siteUrl: "https://acme.atlassian.net",
          }),
      } as never,
      clientFor: () =>
        Promise.resolve({
          ok: true as const,
          client: {
            issueSpec: () =>
              answer instanceof Error
                ? Promise.reject(answer)
                : Promise.resolve(answer),
          } as never,
        }),
      now: () => new Date("2026-09-22T00:00:00Z"),
    },
  };
}

test("freshness compares all versioned sizing inputs", async () => {
  const current = options({
    key: "APP-1",
    summary: "Title",
    descriptionText: "Spec",
    issueType: "Story",
    inputTruncated: false,
    pricingSpecHash: "a".repeat(64),
  });
  assert.equal(
    (await freshProposal(current.value, "org_1", proposal())).freshness,
    "current",
  );
  assert.equal(
    (
      await freshProposal(
        current.value,
        "org_1",
        proposal({ specHash: "b".repeat(64) }),
      )
    ).freshness,
    "stale",
  );
  assert.equal(
    (
      await freshProposal(
        current.value,
        "org_1",
        proposal({ specHashVersion: 2 }),
      )
    ).code,
    "hash_version",
  );
});

test("a confirmed 404 marks the pointer removed and other failures stay unknown", async () => {
  const missing = options(new JiraApiError(404, "missing"));
  assert.equal(
    (await freshProposal(missing.value, "org_1", proposal())).freshness,
    "missing",
  );
  assert.deepEqual(missing.removed, ["jri_1"]);
  const unavailable = options(new TypeError("offline"));
  assert.equal(
    (await freshProposal(unavailable.value, "org_1", proposal())).freshness,
    "unknown",
  );
});

test("live enrichment respects its concurrency bound and input order", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapConcurrent([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(maximum, 2);
});
