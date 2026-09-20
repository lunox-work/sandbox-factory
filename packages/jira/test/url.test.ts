import assert from "node:assert/strict";
import { test } from "node:test";

import { stripTrailingSlashes } from "../src/url.js";

test("a trailing slash is removed so joined paths do not double up", () => {
  assert.equal(
    stripTrailingSlashes("https://acme.atlassian.net/"),
    "https://acme.atlassian.net",
  );
});

test("several trailing slashes are removed", () => {
  assert.equal(
    stripTrailingSlashes("https://acme.atlassian.net///"),
    "https://acme.atlassian.net",
  );
});

test("a URL with no trailing slash is unchanged", () => {
  assert.equal(
    stripTrailingSlashes("https://acme.atlassian.net"),
    "https://acme.atlassian.net",
  );
});

test("slashes inside the URL are left alone", () => {
  // Only the tail is stripped: a path is still a path.
  assert.equal(
    stripTrailingSlashes("https://acme.atlassian.net/wiki/spaces/"),
    "https://acme.atlassian.net/wiki/spaces",
  );
});

test("a string of only slashes becomes empty, and empty stays empty", () => {
  assert.equal(stripTrailingSlashes("////"), "");
  assert.equal(stripTrailingSlashes(""), "");
});

test("a hostile number of trailing slashes is handled in linear time", () => {
  // The regression guard. `siteUrl.replace(/\/+$/, "")` — what this replaced —
  // backtracks polynomially here and takes over a second; CodeQL flagged it as
  // a high-severity ReDoS (alerts 72 and 73 on PR #25). `siteUrl` comes from
  // Atlassian's accessible-resources response and from the stored connection
  // row, so it is not input this package controls.
  //
  // The trailing "a" is what makes it pathological: the anchored match fails
  // at every one of the n starting positions.
  const hostile = `https://acme.atlassian.net${"/".repeat(60_000)}a`;

  const started = Date.now();
  const result = stripTrailingSlashes(hostile);
  const elapsed = Date.now() - started;

  // Nothing to strip: the string does not end in a slash.
  assert.equal(result, hostile);
  // Generous by three orders of magnitude against the ~1300ms the regex took,
  // so this fails on a reintroduced regex without being flaky on a loaded CI
  // runner.
  assert.ok(elapsed < 250, `took ${elapsed}ms, which suggests backtracking`);
});
