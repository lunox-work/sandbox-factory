import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_SCOPES,
  API_TOKEN_PREFIX,
  CLI_CLIENT_IDS,
  cliScopes,
  CONTRIBUTOR_SCOPE,
  CONTRIBUTOR_SCOPES,
  CONTRIBUTOR_TOKEN_PREFIX,
  isApiScope,
  isCliClient,
  isContributorScope,
  MCP_CONTRIBUTOR_PATH,
  MCP_DEFAULT_SCOPES,
  MCP_TOOLSETS,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OFFLINE_ACCESS_SCOPE,
} from "../src/scopes.js";

test("the scope list is the public API's, and only it is recognized", () => {
  assert.deepEqual(API_SCOPES, [
    "workspace:read",
    "integrations:write",
    "bounties:write",
    "pricing:write",
    "specs:write",
    "decisions:confirm",
    "sandboxes:write",
    "submissions:write",
    "judge",
    "webhooks:write",
  ]);
  assert.equal(isApiScope("judge"), true);
  for (const value of ["", "workspace", "tokens:write", "WORKSPACE:READ"])
    assert.equal(isApiScope(value), false);
});

test("each command-line client holds only known scopes, reading included", () => {
  assert.deepEqual([...CLI_CLIENT_IDS], ["duediligence", "carveout"]);
  for (const client of CLI_CLIENT_IDS) {
    assert.ok(cliScopes(client).includes("workspace:read"));
    for (const scope of cliScopes(client))
      assert.equal(isApiScope(scope), true);
    // A client never manages webhooks: that is a person's setup.
    assert.equal(cliScopes(client).includes("webhooks:write"), false);
  }
  // duediligence posts specs its person confirmed; carveout confirms none.
  assert.equal(cliScopes("duediligence").includes("decisions:confirm"), true);
  assert.equal(cliScopes("carveout").includes("decisions:confirm"), false);
  assert.equal(isCliClient("carveout"), true);
  // Inherited names are not clients.
  for (const value of ["", "toString", "constructor", "vscode"])
    assert.equal(isCliClient(value), false);
});

test("each token kind carries a prefix no other credential starts with", () => {
  const prefixes = [
    API_TOKEN_PREFIX,
    CONTRIBUTOR_TOKEN_PREFIX,
    OAUTH_ACCESS_TOKEN_PREFIX,
    OAUTH_REFRESH_TOKEN_PREFIX,
  ];
  for (const prefix of prefixes) {
    for (const other of prefixes)
      if (other !== prefix) assert.equal(other.startsWith(prefix), false);
    // A session token is bare alphanumerics; an underscore tells them apart.
    assert.match(prefix, /_$/);
  }
});

test("MCP asks for reading only by default, and offline access is no API scope", () => {
  assert.deepEqual([...MCP_DEFAULT_SCOPES], ["workspace:read"]);
  assert.equal(isApiScope(OFFLINE_ACCESS_SCOPE), false);
});

test("the contributor scope is no API scope, and no CLI client or workspace toolset holds it", () => {
  assert.deepEqual([...CONTRIBUTOR_SCOPES], [CONTRIBUTOR_SCOPE]);
  assert.equal(isContributorScope("contributions:write"), true);
  assert.equal(isApiScope(CONTRIBUTOR_SCOPE), false);
  for (const scope of API_SCOPES)
    assert.equal(isContributorScope(scope), false);
  for (const client of CLI_CLIENT_IDS)
    assert.equal(
      (cliScopes(client) as readonly string[]).includes(CONTRIBUTOR_SCOPE),
      false,
    );
});

test("the contributor endpoint's tools are its own; every workspace toolset is within /mcp", () => {
  const all = new Set<string>(MCP_TOOLSETS["/mcp"]);
  for (const [path, names] of Object.entries(MCP_TOOLSETS)) {
    if (path === MCP_CONTRIBUTOR_PATH) continue;
    for (const name of names) assert.ok(all.has(name), `${path}: ${name}`);
  }
  assert.ok(MCP_TOOLSETS[MCP_CONTRIBUTOR_PATH].includes("list_contributions"));
  assert.equal(all.has("list_contributions"), false);
});
