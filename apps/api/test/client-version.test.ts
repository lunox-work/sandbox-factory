import assert from "node:assert/strict";
import { test } from "node:test";

import { isOlder } from "../src/client-version.js";
import { createApp } from "../src/routes.js";
import { fakeAuth } from "./token-fakes.js";

/**
 * The floor under the command-line clients: an older one is told to
 * upgrade with 426 before its credential is read; anything else is served
 * as before.
 */

function server(floors: Record<string, string>) {
  return createApp({
    corsOrigins: [],
    auth: fakeAuth(),
    minClientVersions: floors,
    publicUrl: "http://localhost:4000",
  });
}

const as = (value: string) => ({ "Lunox-Client-Version": value });

test("versions compare by number, and a pre-release is below its release", () => {
  assert.equal(isOlder("0.3.9", "0.4.0"), true);
  assert.equal(isOlder("0.4.0", "0.4.0"), false);
  assert.equal(isOlder("0.10.0", "0.4.0"), false);
  assert.equal(isOlder("1.0.0", "0.9.9"), false);
  assert.equal(isOlder("0.4.0-rc.1", "0.4.0"), true);
  assert.equal(isOlder("0.4.0-rc.1", "0.4.0-rc.0"), false);
  assert.equal(isOlder("0.4.1+build.7", "0.4.0"), false);
  assert.equal(isOlder("latest", "0.4.0"), false);
  assert.equal(isOlder("0.3.0", "nonsense"), false);
});

test("a client below its floor is 426 with the minimum, before any credential", async () => {
  const app = server({ duediligence: "0.4.0" });
  const old = await app.request("/api/v1/me", {
    headers: as("duediligence/0.3.9"),
  });
  assert.equal(old.status, 426);
  assert.deepEqual(await old.json(), {
    error:
      "This version of duediligence is too old for this server. Upgrade to 0.4.0 or later.",
    code: "client_too_old",
    minimumVersion: "0.4.0",
  });
  // The MCP endpoints too.
  for (const path of ["/mcp", "/mcp/duediligence"]) {
    const mcp = await app.request(path, {
      method: "POST",
      headers: as("Duediligence/0.1.0"),
    });
    assert.equal(mcp.status, 426, path);
  }
});

test("a current client, another client, or no header is served as before", async () => {
  const app = server({ duediligence: "0.4.0" });
  for (const headers of [
    as("duediligence/0.4.0"),
    as("duediligence/1.2.3"),
    as("carveout/0.0.1"),
    as("duediligence"),
    as("/0.1.0"),
    as("duediligence/garbage"),
    {},
  ]) {
    const res = await app.request("/api/v1/me", { headers });
    // The guard answers next: no credential.
    assert.equal(res.status, 401, JSON.stringify(headers));
  }
  assert.equal(
    (await app.request("/health", { headers: as("duediligence/0.0.1") }))
      .status,
    200,
  );
});

test("no floor configured mounts nothing", async () => {
  const app = server({});
  const res = await app.request("/api/v1/me", {
    headers: as("duediligence/0.0.1"),
  });
  assert.equal(res.status, 401);
});
