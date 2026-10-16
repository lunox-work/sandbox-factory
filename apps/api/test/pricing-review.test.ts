import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoredBountyProposal, StoredBounty } from "@sandbox-factory/db";
import { JiraApiError, type JiraIssueSpec } from "@sandbox-factory/jira";
import { bountySpecHash, type BountyContent } from "sandbox-factory";

import { recentReads } from "../src/jira/recent.js";
import type { RunClientResult } from "../src/pricing/executor.js";
import { freshProposal, mapConcurrent } from "../src/pricing/review.js";

function proposal(
  overrides: Partial<StoredBountyProposal> = {},
): StoredBountyProposal {
  return {
    id: "bpr_1",
    organizationId: "org_1",
    runId: "brn_1",
    bountyId: "bty_1",
    issueKey: "APP-1",
    title: "Title",
    specHash: "a".repeat(64),
    specHashVersion: 2,
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
    version: 0,
    versionedAt: null,
    specRevision: null,
    step: null,
    rubric: null,
    decidedAt: null,
    decidedBy: null,
    decisionDeliveryPolicy: null,
    repositories: [],
    contextVersions: { jira: null, github: null },
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function bounty(overrides: Partial<StoredBounty> = {}): StoredBounty {
  return {
    id: "bty_1",
    organizationId: "org_1",
    title: "Title",
    description: "Spec",
    components: [],
    inputTruncated: false,
    origin: "jira",
    stack: [],
    categories: [],
    createdBy: null,
    revision: 1,
    version: 1,
    approval: null,
    textEditedAt: null,
    jira: {
      issueId: "jri_1",
      boardId: "jrb_1",
      connectionId: "jrc_1",
      externalId: "100",
      key: "APP-1",
      siteUrl: "https://acme.atlassian.net",
      removedAt: null,
    },
    sandbox: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

const jiraSpec = {
  key: "APP-1",
  summary: "Title",
  descriptionText: "Spec",
  components: ["Mailer"],
  inputTruncated: false,
  pricingSpecHash: "a".repeat(64),
};

function options(
  answer: unknown,
  stored: StoredBounty | null = bounty(),
  client?: RunClientResult | "none",
) {
  const removed: string[] = [];
  const refreshed: BountyContent[] = [];
  return {
    removed,
    refreshed,
    value: {
      proposals: {} as never,
      bounties: {
        get: () => Promise.resolve(stored),
        refreshFromJira: (_o: string, _id: string, content: BountyContent) => {
          refreshed.push(content);
          return Promise.resolve(true);
        },
      } as never,
      issues: {
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
      ...(client === "none"
        ? {}
        : {
            clientFor: () =>
              Promise.resolve(
                client ?? {
                  ok: true as const,
                  client: {
                    issueSpec: () =>
                      answer instanceof Error
                        ? Promise.reject(answer)
                        : Promise.resolve(answer),
                  } as never,
                },
              ),
          }),
      now: () => new Date("2026-09-22T00:00:00Z"),
    },
  };
}

test("freshness compares all versioned sizing inputs", async () => {
  const current = options(jiraSpec);
  const fresh = await freshProposal(current.value, "org_1", proposal());
  assert.equal(fresh.freshness, "current");
  assert.equal(fresh.liveUrl, "https://acme.atlassian.net/browse/APP-1");
  // The bounty takes what Jira said.
  assert.deepEqual(current.refreshed[0]?.components, ["Mailer"]);
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
        proposal({ specHashVersion: 1 }),
      )
    ).code,
    "hash_version",
  );
});

test("given recent reads, an issue read in the last minute is not read again", async () => {
  let clock = 0;
  const recent = recentReads<JiraIssueSpec>({ now: () => clock });
  const reads = { client: 0, spec: 0 };
  const state = options(jiraSpec);
  const value = {
    ...state.value,
    recent,
    clientFor: () => {
      reads.client += 1;
      return Promise.resolve({
        ok: true as const,
        client: {
          issueSpec: () => {
            reads.spec += 1;
            return Promise.resolve(jiraSpec);
          },
        } as never,
      });
    },
  };
  const first = await freshProposal(value, "org_1", proposal());
  const again = await freshProposal(value, "org_1", proposal());
  assert.deepEqual(reads, { client: 1, spec: 1 });
  assert.equal(again.freshness, "current");
  assert.equal(again.liveUrl, first.liveUrl);
  assert.deepEqual(again.liveSpec, first.liveSpec);
  // Only the read the bounty took: an answer from memory writes nothing.
  assert.equal(state.refreshed.length, 1);
  // Another organization's bounty on the same issue id is its own read.
  await freshProposal(value, "org_2", proposal());
  assert.deepEqual(reads, { client: 2, spec: 2 });
  clock = 60_000;
  await freshProposal(value, "org_1", proposal());
  assert.deepEqual(reads, { client: 3, spec: 3 });
  // A read that failed is not kept.
  const failing = recentReads<JiraIssueSpec>();
  const broken = options(new Error("Jira down"));
  for (let attempt = 0; attempt < 2; attempt += 1)
    assert.equal(
      (
        await freshProposal(
          { ...broken.value, recent: failing },
          "org_1",
          proposal(),
        )
      ).freshness,
      "unknown",
    );
});

test("a bounty gone from Jira keeps its text and is reviewed against it", async () => {
  const missing = options(new JiraApiError(404, "missing"));
  const stored = await bountySpecHash("Title", "Spec");
  const fresh = await freshProposal(
    missing.value,
    "org_1",
    proposal({ specHash: stored }),
  );
  assert.equal(fresh.freshness, "current");
  assert.equal(fresh.code, "jira_removed");
  assert.equal(fresh.liveUrl, undefined);
  assert.deepEqual(missing.removed, ["jri_1"]);
  // Stale for a reason of its own: that reason is the one given.
  assert.equal(
    (
      await freshProposal(
        options(new JiraApiError(404, "missing")).value,
        "org_1",
        proposal({ specHash: stored, specHashVersion: 1 }),
      )
    ).code,
    "hash_version",
  );

  const unavailable = options(new TypeError("offline"));
  assert.equal(
    (await freshProposal(unavailable.value, "org_1", proposal())).freshness,
    "unknown",
  );
  const refused = options(new JiraApiError(401, "expired"));
  assert.equal(
    (await freshProposal(refused.value, "org_1", proposal())).code,
    "reconnect",
  );
});

test("a bounty written here is reviewed as stored, with no Jira", async () => {
  const written = bounty({
    origin: "manual",
    jira: null,
    description: "New spec",
  });
  const priced = await bountySpecHash("Title", "Spec");
  const state = options(new Error("never read"), written, "none");
  const fresh = await freshProposal(
    state.value,
    "org_1",
    proposal({ specHash: priced }),
  );
  // Its text changed after it was priced.
  assert.equal(fresh.freshness, "stale");
  // No Jira key to name it by.
  assert.equal(fresh.liveKey, undefined);
  assert.equal(fresh.liveSpec?.key, null);
  assert.equal(fresh.liveSpec?.url, null);
  assert.equal(fresh.liveSpec?.descriptionText, "New spec");
  assert.deepEqual(state.refreshed, []);

  const truncated = await freshProposal(
    options(null, { ...written, inputTruncated: true }, "none").value,
    "org_1",
    proposal({ specHash: await bountySpecHash("Title", "New spec") }),
  );
  assert.equal(truncated.freshness, "current");
  assert.equal(truncated.code, "spec_too_large");
});

test("a Jira bounty whose text was changed here is reviewed as stored", async () => {
  const edited = bounty({ textEditedAt: "2026-10-02T00:00:00.000Z" });
  const state = options(new Error("never read"), edited);
  const fresh = await freshProposal(
    state.value,
    "org_1",
    proposal({ specHash: await bountySpecHash("Title", "Spec") }),
  );
  assert.equal(fresh.freshness, "current");
  assert.deepEqual(state.refreshed, []);
});

test("a Jira bounty cannot be checked without its site", async () => {
  const unconfigured = options(null, bounty(), "none");
  assert.deepEqual(
    await freshProposal(unconfigured.value, "org_1", proposal()),
    {
      proposal: proposal(),
      freshness: "unknown",
      checkedAt: "2026-09-22T00:00:00.000Z",
      code: "reconnect",
    },
  );
  const disconnected = options(null, bounty(), {
    ok: false,
    reason: "not-found",
  });
  assert.equal(
    (await freshProposal(disconnected.value, "org_1", proposal())).code,
    "not_found",
  );
});

test("a proposal whose bounty is gone is missing", async () => {
  assert.equal(
    (await freshProposal(options(null, null).value, "org_1", proposal()))
      .freshness,
    "missing",
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
