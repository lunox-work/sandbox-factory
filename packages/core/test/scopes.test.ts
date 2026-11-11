import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_SCOPES,
  CLI_CLIENT_IDS,
  cliScopes,
  isApiScope,
  isCliClient,
} from "../src/scopes.js";

test("the scope list is the public API's, and only it is recognized", () => {
  assert.deepEqual(API_SCOPES, [
    "workspace:read",
    "integrations:write",
    "bounties:write",
    "pricing:write",
    "specs:write",
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
  assert.equal(isCliClient("carveout"), true);
  // Inherited names are not clients.
  for (const value of ["", "toString", "constructor", "vscode"])
    assert.equal(isCliClient(value), false);
});
