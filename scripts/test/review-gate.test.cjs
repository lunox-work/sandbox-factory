const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  decide,
  repairs,
  checksState,
  threads,
  reconcile,
  REPAIR_TIMEOUT,
} = require("../review-gate.cjs");

const head = "a".repeat(40);
const old = "b".repeat(40);
const bot = { login: "coderabbitai[bot]", type: "Bot" };
const actions = { login: "github-actions[bot]", type: "Bot" };
const clean = () => ({
  head,
  trusted: true,
  draft: false,
  conflict: false,
  behind: false,
  repairs: [],
  checks: ["success", "success", "success", "success"],
  reviewStatus: "success",
  review: { commit_id: head, state: "APPROVED" },
  unresolved: 0,
  rabbitThreads: 0,
});

test("only a fully reviewed, approved, passing current head succeeds", () => {
  assert.equal(decide(clean()).state, "success");
  for (const patch of [
    { draft: true },
    { trusted: false },
    { conflict: true },
    { behind: true },
    { reviewStatus: undefined },
    { reviewStatus: "pending" },
    { reviewStatus: "failure" },
    { review: undefined },
    { review: { commit_id: old, state: "APPROVED" } },
    { review: { commit_id: head, state: "CHANGES_REQUESTED" } },
    { unresolved: 1 },
    { checks: ["pending"] },
    { checks: ["failure"] },
  ])
    assert.notEqual(
      decide({ ...clean(), ...patch }).state,
      "success",
      JSON.stringify(patch),
    );
});

test("autofix and CI repair are serialized, bounded and never resolve threads", () => {
  assert.equal(
    decide({ ...clean(), unresolved: 1, rabbitThreads: 1 }).command,
    "autofix",
  );
  assert.equal(
    decide({ ...clean(), checks: ["failure"], rabbitThreads: 1 }).command,
    "fix-ci commit",
  );
  assert.equal(
    decide({ ...clean(), checks: ["failure", "pending"] }).command,
    undefined,
  );
  const now = 100000000;
  const outstanding = { head, created: now - 1000 };
  assert.equal(
    decide({ ...clean(), repairs: [outstanding], behind: true }, now).update,
    undefined,
  );
  assert.equal(
    decide({ ...clean(), repairs: [outstanding] }, now).state,
    "pending",
  );
  assert.equal(
    decide(
      { ...clean(), repairs: [{ head, created: now - REPAIR_TIMEOUT }] },
      now,
    ).attention,
    true,
  );
  const exhausted = Array.from({ length: 3 }, () => ({
    head: old,
    created: now - 1000,
  }));
  assert.equal(
    decide({ ...clean(), repairs: exhausted, rabbitThreads: 1 }).state,
    "failure",
  );
  // Three successful repairs do not prevent a now-clean PR from landing.
  assert.equal(decide({ ...clean(), repairs: exhausted }).state, "success");
});

test("repair markers require the actual Actions bot and valid payload", () => {
  const c = {
    user: actions,
    body: `<!-- review-gate:repair ${JSON.stringify({ head, command: "autofix" })} -->`,
    created_at: "2026-09-22T00:00:00Z",
  };
  assert.equal(repairs([c]).length, 1);
  for (const bad of [
    { ...c, user: { login: actions.login, type: "User" } },
    { ...c, user: bot },
    { ...c, body: "<!-- review-gate:repair invalid -->" },
    { ...c, body: c.body.replace("autofix", "approve") },
    { ...c, body: c.body.replace(head, "no") },
  ])
    assert.deepEqual(repairs([bad]), []);
});

test("check evaluation rejects missing, skipped, cancelled and spoofed checks", () => {
  const good = ["Test (Node 22)", "Test (Node 24)", "Analyze", "CodeQL"].map(
    (name, i) => ({
      id: i + 1,
      name,
      app: {
        slug: name === "CodeQL" ? "github-advanced-security" : "github-actions",
      },
      status: "completed",
      conclusion: "success",
    }),
  );
  assert.deepEqual(checksState(good), Array(4).fill("success"));
  assert.equal(checksState(good.slice(1))[0], "pending");
  assert.equal(
    checksState([{ ...good[0], app: { slug: "other" } }])[0],
    "pending",
  );
  for (const conclusion of [
    "failure",
    "skipped",
    "cancelled",
    "neutral",
    "timed_out",
  ]) {
    assert.equal(
      checksState([...good, { ...good[0], id: 100, conclusion }])[0],
      "failure",
    );
  }
  assert.equal(
    checksState([...good, { ...good[0], id: 100, status: "in_progress" }])[0],
    "pending",
  );
});

test("threads paginate beyond 100, including outdated unresolved threads", async () => {
  const cursors = [];
  const github = {
    graphql: async (_, variables) => {
      cursors.push(variables.cursor);
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: !!variables.cursor },
                { isResolved: false, isOutdated: true },
              ],
              pageInfo: { hasNextPage: !variables.cursor, endCursor: "next" },
            },
          },
        },
      };
    },
  };
  assert.equal((await threads(github, "owner", "repo", 1)).length, 3);
  assert.deepEqual(cursors, [null, "next"]);
});

function fixture(patch = {}) {
  const writes = [],
    comments = [],
    compares = [],
    errors = [];
  let gets = 0;
  const pr = {
    number: 1,
    state: "open",
    draft: false,
    head: { sha: head, repo: { full_name: "o/r" } },
    base: { sha: old, ref: "main", repo: { full_name: "o/r" } },
    // What the Actions token reports for a member whose org membership is
    // private; trust must not depend on it.
    author_association: "CONTRIBUTOR",
    ...patch.pr,
  };
  const names = ["Test (Node 22)", "Test (Node 24)", "Analyze", "CodeQL"];
  const github = {
    rest: {
      pulls: {
        list: "prs",
        listReviews: "reviews",
        get: async () => ({
          data: {
            ...pr,
            head: { ...pr.head, sha: ++gets > 1 && patch.race ? old : head },
          },
        }),
      },
      issues: {
        listComments: "comments",
        createComment: async (c) => {
          comments.push(c);
        },
      },
      checks: { listForRef: "runs" },
      repos: {
        listCommitStatusesForRef: "statuses",
        // Mirrors the real API: pr.base.sha is frozen at PR creation, so a
        // branch that fell behind an advancing base only reads as behind when
        // the comparison is made against the base ref.
        compareCommitsWithBasehead: async ({ basehead }) => {
          compares.push(basehead);
          const from = basehead.split("...")[0];
          return {
            data: { behind_by: patch.behind && from === pr.base.ref ? 1 : 0 },
          };
        },
        createCommitStatus: async (s) => {
          writes.push(s);
        },
      },
    },
    paginate: async (method) => {
      if (patch.error === method) throw new Error("API down");
      return {
        prs: [pr],
        reviews: [{ id: 1, user: bot, commit_id: head, state: "APPROVED" }],
        comments: patch.comments || [],
        runs: names.map((name) => ({
          id: 1,
          name,
          app: {
            slug:
              name === "CodeQL" ? "github-advanced-security" : "github-actions",
          },
          status: "completed",
          conclusion: "success",
        })),
        statuses: [
          { id: 1, context: "CodeRabbit", creator: bot, state: "success" },
        ],
      }[method];
    },
    graphql: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: patch.finding
              ? [
                  {
                    isResolved: false,
                    comments: {
                      nodes: [{ author: { login: "coderabbitai" } }],
                    },
                  },
                ]
              : [],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }),
    request: async (...args) => {
      writes.push(args);
    },
  };
  return {
    github,
    context: {
      repo: { owner: "o", repo: "r" },
      payload: { repository: { default_branch: "main" } },
      runId: 1,
    },
    core: { info() {}, setFailed: (e) => errors.push(e) },
    writes,
    comments,
    compares,
    errors,
  };
}

test("reconciliation revokes old success, reads evidence, then publishes success", async () => {
  const f = fixture();
  await reconcile(f);
  assert.deepEqual(
    f.writes.map((s) => s.state),
    ["pending", "success"],
  );
  assert.ok(f.writes.every((s) => s.sha === head));
});

test("a same-repository PR is trusted whatever GitHub calls its author, and a fork is not", async () => {
  // The fixture's author reads CONTRIBUTOR, as a private org member does.
  const own = fixture();
  await reconcile(own);
  assert.equal(own.writes.at(-1).state, "success");
  const fork = fixture({
    pr: { head: { sha: head, repo: { full_name: "someone/r" } } },
  });
  await reconcile(fork);
  assert.equal(fork.writes.at(-1).state, "failure");
  assert.match(fork.writes.at(-1).description, /Fork/);
});

test("reconciliation fails closed for API failure and head races", async () => {
  {
    const f = fixture({ error: "reviews" });
    await reconcile(f);
    assert.deepEqual(
      f.writes.map((s) => s.state),
      ["pending", "failure"],
    );
    assert.equal(f.errors.length, 1);
  }
  const f = fixture({ race: true, finding: true });
  await reconcile(f);
  assert.deepEqual(
    f.writes.map((s) => s.state),
    ["pending"],
  );
  assert.equal(f.comments.length, 0);
});

test("repeated reconciliation sends one repair until the head changes", async () => {
  const f = fixture({ finding: true });
  await reconcile(f);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /@coderabbitai autofix/);
  assert.doesNotMatch(f.comments[0].body, /@coderabbitai (resolve|approve)/);
  const again = fixture({
    finding: true,
    comments: [
      { ...f.comments[0], user: actions, created_at: new Date().toISOString() },
    ],
  });
  await reconcile(again);
  assert.equal(again.comments.length, 0);
  assert.equal(again.writes.at(-1).state, "pending");
});

test("staleness is measured against the moving base ref, not the frozen base sha", async () => {
  const f = fixture({ behind: true });
  await reconcile({ ...f, updateToken: "test-token" });
  // pr.base.sha never moves once the PR is open, so comparing from it would
  // report behind_by 0 and silently strand the PR behind an advancing main.
  assert.deepEqual(f.compares, [`main...${head}`]);
  assert.equal(f.writes.at(-1).state, "pending");
});

test("updating a stale base requires event-producing token and expected head", async () => {
  const missing = fixture({ behind: true });
  await reconcile(missing);
  assert.equal(missing.writes.at(-1).state, "failure");
  const f = fixture({ behind: true });
  await reconcile({ ...f, updateToken: "test-token" });
  assert.equal(f.writes[1][1].expected_head_sha, head);
  assert.equal(f.writes[1][1].headers.authorization, "token test-token");
  assert.equal(f.writes.at(-1).state, "pending");
});
