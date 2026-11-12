import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GithubAuthError,
  MERGE_BACK_PERMISSIONS,
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

const happy = (request: Recorded): Response => {
  const path = new URL(request.url).pathname;
  if (path === "/repos/acme/shop/git/commits/c0ffee")
    return json({ sha: "c0ffee", tree: { sha: "tree0" } });
  if (path === "/repos/acme/shop/git/trees") return json({ sha: "tree1" }, 201);
  if (path === "/repos/acme/shop/git/commits")
    return json({ sha: "beef" }, 201);
  if (path === "/repos/acme/shop/git/refs")
    return json({ ref: "refs/heads/lunox/sbm_1" }, 201);
  if (path === "/repos/acme/shop/pulls")
    return json(
      { number: 7, html_url: "https://github.com/acme/shop/pull/7" },
      201,
    );
  return json({}, 404);
};

test("a merge-back is one commit on the version's commit, its branch, and a pull request onto the base", async () => {
  const { writer, fetch } = writerWith(happy);
  assert.deepEqual(await writer.open(input), {
    number: 7,
    url: "https://github.com/acme/shop/pull/7",
    commitSha: "beef",
  });
  assert.deepEqual(
    fetch.calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/repos/acme/shop/git/commits/c0ffee"],
      ["POST", "/repos/acme/shop/git/trees"],
      ["POST", "/repos/acme/shop/git/commits"],
      ["POST", "/repos/acme/shop/git/refs"],
      ["POST", "/repos/acme/shop/pulls"],
    ],
  );
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
  assert.deepEqual(fetch.calls[2]?.body, {
    message: "Refunds round to the cent",
    tree: "tree1",
    parents: ["c0ffee"],
  });
  assert.deepEqual(fetch.calls[3]?.body, {
    ref: "refs/heads/lunox/sbm_1",
    sha: "beef",
  });
  assert.deepEqual(fetch.calls[4]?.body, {
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

test("a refusal or a malformed answer from GitHub stops the merge-back", async () => {
  const refused = writerWith((request) =>
    new URL(request.url).pathname.endsWith("/git/refs")
      ? json({ message: "Resource not accessible by integration" }, 403)
      : happy(request),
  );
  await assert.rejects(refused.writer.open(input), GithubAuthError);
  assert.equal(refused.fetch.calls.length, 4);

  const malformed = async (path: string, answer: Response, message: RegExp) => {
    const { writer } = writerWith((request) =>
      new URL(request.url).pathname === path ? answer : happy(request),
    );
    await assert.rejects(writer.open(input), message);
  };
  await malformed(
    "/repos/acme/shop/git/commits/c0ffee",
    json({ sha: "c0ffee" }),
    /no tree/,
  );
  await malformed("/repos/acme/shop/git/commits", json({}, 201), /no sha/);
  await malformed("/repos/acme/shop/pulls", json({ number: "7" }), /no number/);
  await malformed(
    "/repos/acme/shop/git/trees",
    new Response("", { status: 201 }),
    /no object/,
  );
  // The default fetch and API are GitHub's own.
  assert.ok(new PullRequestWriter({ token: () => Promise.resolve("t") }));
});
