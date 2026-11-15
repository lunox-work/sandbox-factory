import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BranchConflictError,
  GithubApiError,
  GithubAuthError,
  MERGE_BACK_PERMISSIONS,
  missingPermissions,
  PullRequestWriter,
} from "../src/index.js";
import { fakeFetch, json, type Recorded } from "./helpers.js";

const input = {
  fullName: "acme/shop",
  baseCommit: "c0ffee",
  base: "main",
  branch: "lunox/sbm_1",
  title: "Refunds round to the cent",
  body: "From a sandbox submission.",
  commitMessage: "Refunds round to the cent",
  files: [{ path: "src/refunds.ts", text: "export const refund = 1;\n" }],
};

/**
 * GitHub's side of one repository, as far as a merge-back touches it:
 * the base commit, branches, commits by sha and open pull requests. Trees
 * are content addressed, so the same files give `tree1` every time.
 */
function repository(
  start: {
    branch?: string;
    commits?: Record<string, string>;
    pulls?: { number: number; html_url: string }[];
  } = {},
) {
  const state = {
    branch: start.branch,
    commits: { c0ffee: "tree0", ...start.commits } as Record<string, string>,
    pulls: [...(start.pulls ?? [])],
  };
  const handler = (request: Recorded): Response => {
    const url = new URL(request.url);
    const path = url.pathname;
    const commit = /^\/repos\/acme\/shop\/git\/commits\/(\w+)$/.exec(path);
    if (commit !== null) {
      const tree = state.commits[commit[1] ?? ""];
      return tree === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ sha: commit[1], tree: { sha: tree } });
    }
    if (path === "/repos/acme/shop/git/trees")
      return json({ sha: "tree1" }, 201);
    if (path === "/repos/acme/shop/git/commits") {
      state.commits["beef"] = (request.body as { tree: string }).tree;
      return json({ sha: "beef" }, 201);
    }
    if (path === "/repos/acme/shop/git/ref/heads/lunox/sbm_1")
      return state.branch === undefined
        ? json({ message: "Not Found" }, 404)
        : json({
            ref: "refs/heads/lunox/sbm_1",
            object: { sha: state.branch },
          });
    if (path === "/repos/acme/shop/git/refs") {
      if (state.branch !== undefined)
        return json({ message: "Reference already exists" }, 422);
      state.branch = (request.body as { sha: string }).sha;
      return json({ ref: "refs/heads/lunox/sbm_1" }, 201);
    }
    if (path === "/repos/acme/shop/pulls" && request.method === "GET")
      return json(state.pulls.slice(0, 1));
    if (path === "/repos/acme/shop/pulls") {
      if (state.pulls.length > 0)
        return json({ message: "A pull request already exists" }, 422);
      const pull = {
        number: 7,
        html_url: "https://github.com/acme/shop/pull/7",
      };
      state.pulls.push(pull);
      return json(pull, 201);
    }
    return json({}, 404);
  };
  return { state, handler };
}

function writerWith(handler: (request: Recorded) => Response) {
  const fetch = fakeFetch(handler);
  return {
    writer: new PullRequestWriter({
      token: () => Promise.resolve("ghs_write"),
      fetch,
      apiUrl: "https://api.github.test/",
    }),
    fetch,
  };
}

const route = (call: Recorded) => {
  const url = new URL(call.url);
  return [call.method, `${url.pathname}${url.search}`];
};
const opened = {
  number: 7,
  url: "https://github.com/acme/shop/pull/7",
  commitSha: "beef",
};

test("a merge-back is one commit on the version's commit, its branch, and a pull request onto the base", async () => {
  const { writer, fetch } = writerWith(repository().handler);
  assert.deepEqual(await writer.open(input), opened);
  assert.deepEqual(fetch.calls.map(route), [
    ["GET", "/repos/acme/shop/git/commits/c0ffee"],
    ["POST", "/repos/acme/shop/git/trees"],
    ["GET", "/repos/acme/shop/git/ref/heads/lunox/sbm_1"],
    ["POST", "/repos/acme/shop/git/commits"],
    ["POST", "/repos/acme/shop/git/refs"],
    [
      "GET",
      "/repos/acme/shop/pulls?head=acme%3Alunox%2Fsbm_1&state=open&per_page=1",
    ],
    ["POST", "/repos/acme/shop/pulls"],
  ]);
  assert.equal(fetch.calls[0]?.headers["authorization"], "Bearer ghs_write");
  assert.equal(fetch.calls[0]?.headers["content-type"], undefined);
  assert.deepEqual(fetch.calls[1]?.body, {
    base_tree: "tree0",
    tree: [
      {
        path: "src/refunds.ts",
        mode: "100644",
        type: "blob",
        content: "export const refund = 1;\n",
      },
    ],
  });
  assert.deepEqual(fetch.calls[3]?.body, {
    message: "Refunds round to the cent",
    tree: "tree1",
    parents: ["c0ffee"],
  });
  assert.deepEqual(fetch.calls[4]?.body, {
    ref: "refs/heads/lunox/sbm_1",
    sha: "beef",
  });
  assert.deepEqual(fetch.calls[6]?.body, {
    title: input.title,
    head: "lunox/sbm_1",
    base: "main",
    body: input.body,
    maintainer_can_modify: false,
  });
  assert.deepEqual(MERGE_BACK_PERMISSIONS, {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  });
});

test("opened again after a partial failure, the branch and pull request already there are reused", async () => {
  // The branch and the pull request were made, but never recorded.
  const done = repository({
    branch: "beef",
    commits: { beef: "tree1" },
    pulls: [{ number: 7, html_url: "https://github.com/acme/shop/pull/7" }],
  });
  const again = writerWith(done.handler);
  assert.deepEqual(await again.writer.open(input), opened);
  assert.deepEqual(
    again.fetch.calls.filter((call) => call.method === "POST").map(route),
    // The tree is content addressed; asking for it again changes nothing.
    [["POST", "/repos/acme/shop/git/trees"]],
  );

  // The branch was made, the pull request was not.
  const half = repository({ branch: "beef", commits: { beef: "tree1" } });
  const resumed = writerWith(half.handler);
  assert.deepEqual(await resumed.writer.open(input), opened);
  assert.deepEqual(
    resumed.fetch.calls.filter((call) => call.method === "POST").map(route),
    [
      ["POST", "/repos/acme/shop/git/trees"],
      ["POST", "/repos/acme/shop/pulls"],
    ],
  );
  assert.equal(half.state.pulls.length, 1);
});

test("a branch someone pushed other work to is refused, never overwritten", async () => {
  const pushed = repository({ branch: "f00d", commits: { f00d: "tree9" } });
  const { writer, fetch } = writerWith(pushed.handler);
  const error = await writer.open(input).then(
    () => assert.fail("opened"),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof BranchConflictError);
  assert.equal(error.branch, "lunox/sbm_1");
  assert.equal(pushed.state.branch, "f00d");
  assert.deepEqual(
    fetch.calls.filter((call) => call.method === "POST").map(route),
    [["POST", "/repos/acme/shop/git/trees"]],
  );
});

test("a request racing another to the branch or the pull request takes what the other made", async () => {
  // The branch appears between the read and the write.
  const raced = repository();
  const { writer } = writerWith((request) => {
    const path = new URL(request.url).pathname;
    if (
      path === "/repos/acme/shop/git/refs" &&
      raced.state.branch === undefined
    )
      raced.state.branch = "beef";
    return raced.handler(request);
  });
  assert.deepEqual(await writer.open(input), opened);

  // The pull request appears between the list and the open.
  const pr = repository({ branch: "beef", commits: { beef: "tree1" } });
  let listed = 0;
  const second = writerWith((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/repos/acme/shop/pulls" && request.method === "GET") {
      listed += 1;
      if (listed === 1) return json([]);
    }
    if (url.pathname === "/repos/acme/shop/pulls" && request.method === "POST")
      return json({ message: "A pull request already exists" }, 422);
    return pr.handler(request);
  });
  pr.state.pulls.push({
    number: 7,
    html_url: "https://github.com/acme/shop/pull/7",
  });
  assert.deepEqual(await second.writer.open(input), opened);

  // A 422 that left nothing to take is GitHub's refusal, as it was.
  const refusedRef = writerWith((request) =>
    new URL(request.url).pathname === "/repos/acme/shop/git/refs"
      ? json({ message: "Invalid" }, 422)
      : repository().handler(request),
  );
  await assert.rejects(refusedRef.writer.open(input), GithubApiError);
  const refusedPull = writerWith((request) =>
    new URL(request.url).pathname === "/repos/acme/shop/pulls" &&
    request.method === "POST"
      ? json({ message: "Validation failed" }, 422)
      : repository().handler(request),
  );
  await assert.rejects(refusedPull.writer.open(input), GithubApiError);
});

test("a refusal or a malformed answer from GitHub stops the merge-back", async () => {
  const happy = (request: Recorded) => repository().handler(request);
  const refused = writerWith((request) =>
    new URL(request.url).pathname.endsWith("/git/refs")
      ? json({ message: "Resource not accessible by integration" }, 403)
      : happy(request),
  );
  await assert.rejects(refused.writer.open(input), GithubAuthError);
  assert.equal(refused.fetch.calls.length, 5);
  const failing = writerWith((request) =>
    new URL(request.url).pathname === "/repos/acme/shop/pulls"
      ? json({ message: "Server Error" }, 500)
      : happy(request),
  );
  await assert.rejects(failing.writer.open(input), GithubApiError);
  // A branch read that fails is not a missing branch.
  const unread = writerWith((request) =>
    new URL(request.url).pathname.includes("/git/ref/")
      ? json({ message: "Server Error" }, 502)
      : happy(request),
  );
  await assert.rejects(unread.writer.open(input), GithubApiError);

  const malformed = async (
    matches: (request: Recorded) => boolean,
    answer: () => Response,
    message: RegExp,
  ) => {
    const { writer } = writerWith((request) =>
      matches(request) ? answer() : happy(request),
    );
    await assert.rejects(writer.open(input), message);
  };
  const at =
    (path: string, method = "GET") =>
    (request: Recorded) =>
      new URL(request.url).pathname === path && request.method === method;
  await malformed(
    at("/repos/acme/shop/git/commits/c0ffee"),
    () => json({ sha: "c0ffee" }),
    /no tree/,
  );
  await malformed(
    at("/repos/acme/shop/git/commits", "POST"),
    () => json({}, 201),
    /no sha/,
  );
  await malformed(
    at("/repos/acme/shop/git/trees", "POST"),
    () => json({}, 201),
    /no sha/,
  );
  await malformed(
    at("/repos/acme/shop/pulls", "POST"),
    () => json({ number: "7" }),
    /no number/,
  );
  await malformed(
    at("/repos/acme/shop/pulls"),
    () => json({ number: 7 }),
    /no list/,
  );
  await malformed(
    at("/repos/acme/shop/git/ref/heads/lunox/sbm_1"),
    () => json({ ref: "refs/heads/lunox/sbm_1" }),
    /no commit/,
  );
  await malformed(
    at("/repos/acme/shop/git/trees", "POST"),
    () => new Response("", { status: 201 }),
    /no object/,
  );
  // The default fetch and API are GitHub's own.
  assert.ok(new PullRequestWriter({ token: () => Promise.resolve("t") }));
});

test("the lookups read a branch, a commit's tree and an open pull request", async () => {
  const done = repository({
    branch: "beef",
    commits: { beef: "tree1" },
    pulls: [{ number: 7, html_url: "https://github.com/acme/shop/pull/7" }],
  });
  const { writer } = writerWith(done.handler);
  assert.equal(await writer.getBranch("acme/shop", "lunox/sbm_1"), "beef");
  assert.equal(await writer.getBranch("acme/shop", "lunox/sbm_2"), null);
  assert.deepEqual(await writer.getCommit("acme/shop", "beef"), {
    sha: "beef",
    treeSha: "tree1",
  });
  assert.deepEqual(
    await writer.findOpenPullRequest("acme/shop", "lunox/sbm_1"),
    { number: 7, url: "https://github.com/acme/shop/pull/7" },
  );
  assert.equal(
    await writerWith(repository().handler).writer.findOpenPullRequest(
      "acme/shop",
      "lunox/sbm_1",
    ),
    null,
  );
});

test("missing permissions are named by what merge-back needs, a higher level covering a lower", () => {
  assert.deepEqual(
    missingPermissions(
      { contents: "read", metadata: "read", issues: "read" },
      MERGE_BACK_PERMISSIONS,
    ),
    ["contents:write", "pull_requests:write"],
  );
  assert.deepEqual(
    missingPermissions(
      { contents: "admin", pull_requests: "write", metadata: "read" },
      MERGE_BACK_PERMISSIONS,
    ),
    [],
  );
  assert.deepEqual(missingPermissions({}, { metadata: "read" }), [
    "metadata:read",
  ]);
});

const pullAt = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: "https://github.com/acme/shop/pull/7",
  title: "Fix it",
  state: "open",
  merged: false,
  merge_commit_sha: "test-merge-sha",
  mergeable: true,
  head: { sha: "beef", ref: "lunox/sbm_1" },
  ...overrides,
});

test("a pull request is read back with its head, whether it merges and what it landed as", async () => {
  const { writer, fetch } = writerWith(() => json(pullAt()));
  assert.deepEqual(await writer.getPullRequest("acme/shop", 7), {
    number: 7,
    url: "https://github.com/acme/shop/pull/7",
    title: "Fix it",
    state: "open",
    merged: false,
    // GitHub's test merge commit is not a landing.
    mergeCommitSha: null,
    headSha: "beef",
    mergeable: true,
  });
  assert.equal(
    fetch.calls[0]?.url,
    "https://api.github.test/repos/acme/shop/pulls/7",
  );
  const merged = writerWith(() =>
    json(
      pullAt({
        state: "closed",
        merged: true,
        merge_commit_sha: "landed",
        mergeable: null,
      }),
    ),
  );
  const read = await merged.writer.getPullRequest("acme/shop", 7);
  assert.equal(read.merged, true);
  assert.equal(read.mergeCommitSha, "landed");
  assert.equal(read.mergeable, null);
  assert.equal(
    (
      await writerWith(() =>
        json(pullAt({ title: undefined })),
      ).writer.getPullRequest("acme/shop", 7)
    ).title,
    "",
  );
  await assert.rejects(
    writerWith(() => json({ number: 7, html_url: "x" })).writer.getPullRequest(
      "acme/shop",
      7,
    ),
    /no state/,
  );
});

test("a merge is squashed at the head CI was read on; GitHub's refusal is answered, not thrown", async () => {
  const done = writerWith(() => json({ merged: true, sha: "landed" }));
  assert.deepEqual(
    await done.writer.merge("acme/shop", 7, { sha: "beef", title: "Fix it" }),
    { merged: true, sha: "landed" },
  );
  const call = done.fetch.calls[0];
  assert.equal(call?.method, "PUT");
  assert.equal(
    call?.url,
    "https://api.github.test/repos/acme/shop/pulls/7/merge",
  );
  assert.deepEqual(call?.body, {
    sha: "beef",
    merge_method: "squash",
    commit_title: "Fix it (#7)",
  });

  for (const [status, message] of [
    [
      405,
      "At least 1 approving review is required by reviewers with write access.",
    ],
    [409, "Head branch was modified. Review and try the merge again."],
    [422, 'Required status check "build" is expected.'],
  ] as const) {
    const refused = writerWith(() => json({ message }, status));
    assert.deepEqual(
      await refused.writer.merge("acme/shop", 7, { sha: "beef", title: "x" }),
      { merged: false, status, reason: message },
    );
  }
  await assert.rejects(
    writerWith(() =>
      json({ message: "Resource not accessible" }, 403),
    ).writer.merge("acme/shop", 7, { sha: "beef", title: "x" }),
    GithubAuthError,
  );
  await assert.rejects(
    writerWith(() => json({ merged: false }, 200)).writer.merge(
      "acme/shop",
      7,
      { sha: "beef", title: "x" },
    ),
    /no commit/,
  );
});
