/**
 * The Jira write-back routes: retry, check and cancel. Each answers for the
 * write as it stands, so a retry never sends a comment that no longer says
 * what the proposal is, and another organization's write is not there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoredBountyWriteback } from "@sandbox-factory/db";

import type { Auth } from "../src/auth.js";
import type { PricingRouteOptions } from "../src/pricing/routes.js";
import { createApp } from "../src/routes.js";

const headers = { cookie: "session=1", "content-type": "application/json" };
const stamp = "2026-10-01T00:00:00.000Z";

const write: StoredBountyWriteback = {
  id: "bwb_1",
  organizationId: "org_1",
  proposalId: "bpr_1",
  proposalRevision: 3,
  kind: "approved",
  status: "failed",
  step: "comment",
  payload: {} as never,
  jiraCommentId: null,
  errorCode: "jira_unavailable",
  commentAttemptedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
};

function fakeAuth(): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({
          user: { id: "user_1", email: "u@example.test", name: "User" },
          session: { id: "session_1" },
        }),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

function harness(
  options: {
    role?: string;
    write?: Partial<StoredBountyWriteback>;
    /** The proposal as it stands now; approved at the write's revision. */
    proposal?: { revision: number; status: string } | null;
    reconcile?: "adopted" | "none" | "multiple" | "not-uncertain";
    cancelled?: boolean;
  } = {},
) {
  const starts: string[] = [];
  const stored = { ...write, ...options.write };
  const pricing = {
    rateCards: {} as never,
    runs: {} as never,
    boards: {} as never,
    specs: {} as never,
    issues: {} as never,
    bounties: {} as never,
    supportedCurrencies: new Set(["USD"]),
    proposals: {
      get: (organizationId: string, id: string) =>
        Promise.resolve(
          organizationId === "org_1" && id === stored.proposalId
            ? options.proposal === undefined
              ? { revision: stored.proposalRevision, status: "approved" }
              : options.proposal
            : null,
        ),
    } as never,
    writebacks: {
      get: (organizationId: string, id: string) =>
        Promise.resolve(
          organizationId === "org_1" && id === stored.id ? stored : null,
        ),
      cancel: () =>
        Promise.resolve(
          options.cancelled === false
            ? null
            : { ...stored, status: "cancelled" },
        ),
    } as never,
    delivery: {
      start: (_organizationId: string, id: string) => {
        starts.push(id);
      },
      reconcile: () =>
        Promise.resolve({
          status: options.reconcile ?? "none",
          operation: stored,
        }),
    } as never,
  } as PricingRouteOptions;
  const app = createApp({
    corsOrigins: ["https://app.test"],
    auth: fakeAuth(),
    organizations: {
      roleOf: (_user: string, organizationId: string) =>
        Promise.resolve(
          organizationId === "org_1" ? (options.role ?? "owner") : undefined,
        ),
    } as never,
    pricing,
  });
  const post = (path: string, organizationId = "org_1") =>
    app.request(`/api/v1/orgs/${organizationId}/writebacks/${path}`, {
      method: "POST",
      headers,
      body: "{}",
    });
  return { post, starts };
}

test("a failed write that still describes its proposal is sent again", async () => {
  const state = harness();
  const response = await state.post("bwb_1/retry");
  assert.equal(response.status, 202);
  assert.deepEqual(state.starts, ["bwb_1"]);
});

test("a write for a proposal decided again since is not retried", async () => {
  // Unapproved and re-priced after the approval's comment failed: sending
  // it now would post the old price as approved.
  for (const proposal of [
    { revision: 5, status: "approved" },
    { revision: 3, status: "proposed" },
  ]) {
    const state = harness({ proposal });
    const response = await state.post("bwb_1/retry");
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "writeback_outdated",
    );
    assert.deepEqual(state.starts, []);
  }
});

test("only a failed or waiting write is retried", async () => {
  for (const status of ["running", "done", "cancelled"] as const) {
    const state = harness({ write: { status } });
    const response = await state.post("bwb_1/retry");
    assert.equal(response.status, 409, status);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "writeback_not_retryable",
    );
    assert.deepEqual(state.starts, []);
  }
  const uncertain = harness({ write: { status: "uncertain" } });
  assert.equal(
    (
      (await (await uncertain.post("bwb_1/retry")).json()) as {
        code: string;
      }
    ).code,
    "writeback_uncertain",
  );
});

test("another organization's write, or one whose proposal is gone, is not found", async () => {
  const state = harness();
  // Not a member there: the membership guard answers before the route.
  assert.equal((await state.post("bwb_1/retry", "org_2")).status, 404);
  assert.equal((await state.post("bwb_x/retry")).status, 404);
  assert.equal((await state.post("bwb_x/cancel")).status, 404);
  assert.equal(
    (await harness({ proposal: null }).post("bwb_1/retry")).status,
    404,
  );
  assert.deepEqual(state.starts, []);
});

test("a write is cancelled unless its state forbids it", async () => {
  const cancelled = await harness().post("bwb_1/cancel");
  assert.equal(cancelled.status, 200);
  const refused = await harness({ cancelled: false }).post("bwb_1/cancel");
  assert.equal(refused.status, 409);
  assert.equal(
    ((await refused.json()) as { code: string }).code,
    "writeback_busy",
  );
});

test("a check that adopts nothing says why, with a code and a sentence", async () => {
  for (const [status, code] of [
    ["none", "reconcile_none"],
    ["multiple", "reconcile_multiple"],
    ["not-uncertain", "reconcile_not_uncertain"],
  ] as const) {
    const response = await harness({ reconcile: status }).post(
      "bwb_1/reconcile",
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; error: string };
    assert.equal(body.code, code);
    assert.ok(body.error.length > 0);
  }
  assert.equal(
    (await harness({ reconcile: "adopted" }).post("bwb_1/reconcile")).status,
    200,
  );
});

test("members may not retry, check or cancel a write", async () => {
  const state = harness({ role: "member" });
  for (const action of ["retry", "reconcile", "cancel"]) {
    assert.equal((await state.post(`bwb_1/${action}`)).status, 403, action);
  }
  assert.deepEqual(state.starts, []);
});
