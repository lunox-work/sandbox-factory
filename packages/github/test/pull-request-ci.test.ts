import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CI_READ_PERMISSIONS,
  GithubAuthError,
  PullRequestCiReader,
  summarizeCi,
} from "../src/index.js";
import { fakeFetch, json, type Recorded } from "./helpers.js";

const run = (
  name: string,
  status: string,
  conclusion: string | null = null,
) => ({ name, status, conclusion, url: `https://ci.test/${name}` });
const status = (context: string, state: string) => ({
  context,
  state,
  url: `https://ci.test/${context}`,
});

test("CI reads failing on any failure, pending on anything unfinished, passing when all passed", () => {
  assert.deepEqual(
    summarizeCi(
      [
        run("build", "completed", "success"),
        run("lint", "completed", "neutral"),
        run("e2e", "completed", "timed_out"),
      ],
      [status("ci/legacy", "failure"), status("deploy", "pending")],
      { graceOver: false },
    ),
    {
      state: "failing",
      total: 5,
      passed: 2,
      failed: 2,
      pending: 1,
      failing: ["e2e", "ci/legacy"],
      detailsUrl: "https://ci.test/e2e",
    },
  );
  const pending = summarizeCi(
    [run("build", "completed", "success"), run("test", "in_progress")],
    [],
    { graceOver: true },
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.pending, 1);
  const passing = summarizeCi(
    [run("build", "completed", "success"), run("docs", "completed", "skipped")],
    [status("coverage", "success")],
    { graceOver: false },
  );
  assert.equal(passing.state, "passing");
  assert.equal(passing.passed, 3);
  assert.deepEqual(passing.failing, []);
  assert.equal(passing.detailsUrl, "https://ci.test/build");
  assert.equal(
    summarizeCi([run("x", "completed", "cancelled")], [], { graceOver: false })
      .state,
    "failing",
  );
  assert.equal(
    summarizeCi([], [status("x", "error")], { graceOver: false }).state,
    "failing",
  );
});

test("no checks at all are pending until the grace period ends, then none", () => {
  const early = summarizeCi([], [], { graceOver: false });
  assert.equal(early.state, "pending");
  assert.equal(early.total, 0);
  assert.equal(early.detailsUrl, null);
  assert.equal(summarizeCi([], [], { graceOver: true }).state, "none");
});

test("a failing summary keeps at most twenty names", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    run(`job-${index}`, "completed", "failure"),
  );
  const summary = summarizeCi(many, [], { graceOver: false });
  assert.equal(summary.failed, 25);
  assert.equal(summary.failing.length, 20);
});

test("check runs and statuses are read for the head commit with the CI token, skipping malformed entries", async () => {
  const fetch = fakeFetch((request: Recorded) => {
    const url = new URL(request.url);
    if (url.pathname === "/repos/acme/shop/commits/beef/check-runs")
      return json({
        total_count: 3,
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/shop/runs/1",
          },
          {
            name: "test",
            status: "queued",
            conclusion: null,
            details_url: "https://ci.test/test",
          },
          { status: "completed" },
        ],
      });
    if (url.pathname === "/repos/acme/shop/commits/beef/status")
      return json({
        state: "pending",
        statuses: [
          {
            context: "ci/legacy",
            state: "success",
            target_url: "https://ci.test/legacy",
          },
          { state: "success" },
          null,
        ],
      });
    return json({ message: "Not Found" }, 404);
  });
  const reader = new PullRequestCiReader({
    token: () => Promise.resolve("ghs_ci"),
    fetch,
    apiUrl: "https://api.github.com",
  });
  assert.deepEqual(await reader.checkRuns("acme/shop", "beef"), [
    {
      name: "build",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/shop/runs/1",
    },
    {
      name: "test",
      status: "queued",
      conclusion: null,
      url: "https://ci.test/test",
    },
  ]);
  assert.deepEqual(await reader.statuses("acme/shop", "beef"), [
    { context: "ci/legacy", state: "success", url: "https://ci.test/legacy" },
  ]);
  assert.equal(fetch.calls[0]?.headers["authorization"], "Bearer ghs_ci");
  assert.match(fetch.calls[0]?.url ?? "", /per_page=100/);
  assert.deepEqual(CI_READ_PERMISSIONS, {
    checks: "read",
    statuses: "read",
    metadata: "read",
  });
});

test("a refused CI read throws GitHub's error; an answer that is no list is refused", async () => {
  const refused = new PullRequestCiReader({
    token: () => Promise.resolve("ghs_ci"),
    fetch: fakeFetch(() => json({ message: "Resource not accessible" }, 403)),
  });
  await assert.rejects(refused.checkRuns("acme/shop", "beef"), GithubAuthError);
  const odd = new PullRequestCiReader({
    token: () => Promise.resolve("ghs_ci"),
    fetch: fakeFetch(() => json({ total_count: 0 })),
  });
  await assert.rejects(odd.checkRuns("acme/shop", "beef"), /no list/);
  await assert.rejects(odd.statuses("acme/shop", "beef"), /no list/);
});
