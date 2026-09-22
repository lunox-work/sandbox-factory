import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BountyProposalStore,
  BountyWritebackStore,
  JiraBoardStore,
  JiraConnectionStore,
  JiraIssueStore,
  StoredBountyProposal,
  StoredBountyWriteback,
} from "@sandbox-factory/db";
import {
  JiraApiError,
  type JiraClient,
  type JiraWriteClient,
} from "@sandbox-factory/jira";

import { BountyDelivery, commentText } from "../src/bounty/delivery.js";

function operation(
  overrides: Partial<StoredBountyWriteback> = {},
): StoredBountyWriteback {
  return {
    id: "bwo_1",
    organizationId: "org_1",
    proposalId: "bpr_1",
    proposalRevision: 2,
    kind: "approved",
    status: "pending",
    step: "comment",
    payload: {
      complexity: "M",
      amountMinor: 25000,
      currency: "USD",
      proposalUrl: "https://app.test/p/1",
    },
    jiraCommentId: null,
    errorCode: null,
    commentAttemptedAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(): StoredBountyProposal {
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
      xsMinor: 100,
      sMinor: 100,
      mMinor: 200,
      lMinor: 300,
      xlMinor: 400,
      revision: 1,
    },
    modelComplexity: "M",
    modelConfidence: "high",
    modelRationale: "private model text",
    unsizedReason: null,
    inputTruncated: false,
    actualModel: "model",
    promptVersion: "v1",
    complexity: "M",
    sizedBy: "model",
    resizedBy: null,
    resizedAt: null,
    amountMinor: 25000,
    currency: "USD",
    status: "approved",
    revision: 2,
    decidedAt: "2026-09-22T00:00:00.000Z",
    decidedBy: "usr_1",
    decisionDeliveryPolicy: "requested",
    replacesProposalId: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

function harness(
  options: {
    op?: StoredBountyWriteback;
    commentError?: Error;
    labelError?: Error;
    comments?: unknown[];
    commentsError?: Error;
    /** Whether the board's site holds the write grant. Default yes. */
    writeGranted?: boolean;
    boardMissing?: boolean;
    claimMiss?: boolean;
    specHash?: string;
  } = {},
) {
  let current = options.op ?? operation();
  const events: string[] = [];
  const writebacks = {
    claim: () => {
      if (options.claimMiss) return Promise.resolve(null);
      current = { ...current, status: "running" };
      return Promise.resolve(current);
    },
    heartbeat: () => Promise.resolve(true),
    get: () => Promise.resolve(current),
    markCommentAttempted: () => {
      events.push("attempt");
      return Promise.resolve(true);
    },
    recordComment: (
      _o: string,
      _i: string,
      _l: string,
      commentId: string,
      needsLabel: boolean,
    ) => {
      events.push(`comment:${commentId}`);
      current = {
        ...current,
        jiraCommentId: commentId,
        step: needsLabel ? "label" : "comment",
        status: needsLabel ? "running" : "done",
      };
      return Promise.resolve(current);
    },
    completeLabel: () => {
      events.push("label-done");
      current = { ...current, status: "done" };
      return Promise.resolve(current);
    },
    fail: (
      _o: string,
      _i: string,
      _l: string,
      status: "failed" | "uncertain" | "cancelled",
      code: string,
    ) => {
      events.push(`${status}:${code}`);
      current = { ...current, status, errorCode: code };
      return Promise.resolve(current);
    },
    cancel: () => {
      events.push("cancelled");
      current = { ...current, status: "cancelled" };
      return Promise.resolve(current);
    },
    adoptComment: (_o: string, _i: string, id: string) => {
      current = {
        ...current,
        status: "pending",
        step: "label",
        jiraCommentId: id,
      };
      return Promise.resolve(current);
    },
  } as unknown as BountyWritebackStore;
  const readClient = {
    issueSpec: () =>
      Promise.resolve({
        pricingSpecHash: options.specHash ?? "a".repeat(64),
        inputTruncated: false,
      }),
    comments: () =>
      options.commentsError === undefined
        ? Promise.resolve(options.comments ?? [])
        : Promise.reject(options.commentsError),
  } as unknown as JiraClient;
  const writeClient = {
    addComment: () =>
      options.commentError === undefined
        ? Promise.resolve("comment_1")
        : Promise.reject(options.commentError),
    addLabel: () => {
      events.push("label");
      return options.labelError === undefined
        ? Promise.resolve()
        : Promise.reject(options.labelError);
    },
  } as unknown as JiraWriteClient;
  const delivery = new BountyDelivery({
    writebacks,
    proposals: {
      get: () => Promise.resolve(proposal()),
    } as unknown as BountyProposalStore,
    issues: {
      get: () =>
        Promise.resolve({
          id: "jri_1",
          boardId: "jrb_1",
          externalId: "100",
          key: "APP-1",
        }),
    } as unknown as JiraIssueStore,
    boards: {
      forRun: () =>
        Promise.resolve(
          options.boardMissing
            ? null
            : {
                board: { id: "jrb_1" },
                connectionId: "jrc_1",
              },
        ),
    } as unknown as JiraBoardStore,
    connections: {
      get: () =>
        Promise.resolve({
          healthy: true,
          scopes: ["write:jira-work"],
          resourceScopes: ["write:jira-work"],
          writeGranted: options.writeGranted ?? true,
        }),
    } as unknown as JiraConnectionStore,
    clientsFor: () =>
      Promise.resolve({ ok: true, client: readClient, writeClient }),
    leaseToken: () => "lease",
  });
  return { delivery, events, current: () => current };
}

test("approval posts one fixed comment then adds the label", async () => {
  const state = harness();
  const result = await state.delivery.execute("org_1", "bwo_1");
  assert.equal(result?.status, "done");
  assert.deepEqual(state.events, [
    "attempt",
    "comment:comment_1",
    "label",
    "label-done",
  ]);
  assert.match(commentText(operation()), /Bounty approved: M — USD 250\.00/);
  assert.ok(!commentText(operation()).includes("private model text"));
  assert.match(
    commentText(
      operation({
        kind: "superseded",
        payload: {
          ...operation().payload,
          replacementUrl: "https://app.test/p/2",
        },
      }),
    ),
    /Previous: https:\/\/app\.test\/p\/1\. Replacement: https:\/\/app\.test\/p\/2\./,
  );
});

test("known Jira rejection is failed while an ambiguous send is uncertain", async () => {
  const rejected = harness({
    commentError: new JiraApiError(403, "forbidden"),
  });
  await rejected.delivery.execute("org_1", "bwo_1");
  assert.ok(rejected.events.includes("failed:permission"));

  const ambiguous = harness({ commentError: new TypeError("network") });
  await ambiguous.delivery.execute("org_1", "bwo_1");
  assert.ok(ambiguous.events.includes("uncertain:jira_uncertain"));
});

test("a stale approval remains approved but its delivery fails before sending", async () => {
  const state = harness({ specHash: "b".repeat(64) });
  const result = await state.delivery.execute("org_1", "bwo_1");
  assert.equal(result?.status, "failed");
  assert.ok(state.events.includes("failed:proposal_stale"));
  assert.ok(!state.events.includes("attempt"));
});

test("a site that no longer holds the write grant fails preflight before sending", async () => {
  // Queued while the site could write, run after it was connected again
  // without the scope: the operation fails here, with a code that says why,
  // rather than at Jira with a 401 that reads as a dead credential.
  const state = harness({ writeGranted: false });
  const result = await state.delivery.execute("org_1", "bwo_1");
  assert.equal(result?.status, "failed");
  assert.ok(state.events.includes("failed:write_consent_required"));
  assert.ok(!state.events.includes("attempt"));
});

test("a missing board fails preflight and an already-finished operation is a read", async () => {
  const missing = harness({ boardMissing: true });
  assert.equal(
    (await missing.delivery.execute("org_1", "bwo_1"))?.errorCode,
    "not_found",
  );
  const finished = harness({
    op: operation({ status: "done" }),
    claimMiss: true,
  });
  assert.equal(
    (await finished.delivery.execute("org_1", "bwo_1"))?.status,
    "done",
  );
});

test("a label retry never posts a second comment", async () => {
  const state = harness({
    op: operation({
      status: "failed",
      step: "label",
      jiraCommentId: "comment_1",
    }),
  });
  await state.delivery.execute("org_1", "bwo_1");
  assert.deepEqual(state.events, ["label", "label-done"]);
});

test("a failed label remains safely retryable without reposting", async () => {
  const state = harness({
    op: operation({
      status: "failed",
      step: "label",
      jiraCommentId: "comment_1",
    }),
    labelError: new JiraApiError(403, "forbidden"),
  });
  const result = await state.delivery.execute("org_1", "bwo_1");
  assert.equal(result?.status, "failed");
  assert.deepEqual(state.events, ["label", "failed:permission"]);
});

test("a follow-up comment completes without adding the bounty label", async () => {
  const state = harness({ op: operation({ kind: "rejected" }) });
  const result = await state.delivery.execute("org_1", "bwo_1");
  assert.equal(result?.status, "done");
  assert.deepEqual(state.events, ["attempt", "comment:comment_1"]);
});

test("reconciliation adopts exactly one matching fixed comment", async () => {
  const uncertain = operation({
    status: "uncertain",
    commentAttemptedAt: "2026-09-22T00:00:01.000Z",
  });
  const body = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: commentText(uncertain) }],
      },
    ],
  };
  const state = harness({ op: uncertain, comments: [{ id: "10", body }] });
  const result = await state.delivery.reconcile("org_1", "bwo_1");
  assert.equal(result.status, "adopted");
  assert.equal(state.current().jiraCommentId, "10");
});

test("reconciliation never guesses when there are zero, multiple, or unreadable matches", async () => {
  const uncertain = operation({ status: "uncertain" });
  const body = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: commentText(uncertain) }],
      },
    ],
  };
  assert.equal(
    (await harness({ op: uncertain }).delivery.reconcile("org_1", "bwo_1"))
      .status,
    "none",
  );
  assert.equal(
    (
      await harness({
        op: uncertain,
        comments: [
          { id: "1", body },
          { id: "2", body },
        ],
      }).delivery.reconcile("org_1", "bwo_1")
    ).status,
    "multiple",
  );
  assert.equal(
    (
      await harness({
        op: uncertain,
        commentsError: new Error("forbidden"),
      }).delivery.reconcile("org_1", "bwo_1")
    ).status,
    "none",
  );
  assert.equal(
    (
      await harness({ op: operation({ status: "done" }) }).delivery.reconcile(
        "org_1",
        "bwo_1",
      )
    ).status,
    "not-uncertain",
  );
});
