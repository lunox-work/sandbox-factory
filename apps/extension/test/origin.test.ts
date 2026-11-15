import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PLATFORM_ORIGIN,
  resolvePlatformOrigin,
  tokenKeyFor,
  tokenProblem,
  tokensPageUrl,
} from "../src/origin.js";

test("the platform origin comes from user settings only, and tokens are bound to it", () => {
  assert.deepEqual(resolvePlatformOrigin(undefined), {
    origin: DEFAULT_PLATFORM_ORIGIN,
    overrideIgnored: false,
    invalid: false,
  });
  assert.deepEqual(
    resolvePlatformOrigin({
      defaultValue: "http://localhost:4000",
      globalValue: "https://api.example.test/base/",
    }),
    {
      origin: "https://api.example.test",
      overrideIgnored: false,
      invalid: false,
    },
  );
  // A repository's settings cannot redirect authenticated requests.
  assert.deepEqual(
    resolvePlatformOrigin({
      defaultValue: "http://localhost:4000",
      globalValue: "https://api.example.test",
      workspaceValue: "https://evil.example.test",
    }),
    {
      origin: "https://api.example.test",
      overrideIgnored: true,
      invalid: false,
    },
  );
  assert.deepEqual(
    resolvePlatformOrigin({
      defaultValue: "https://platform.lunox.work",
      workspaceFolderValue: "https://evil.example.test",
    }),
    {
      origin: "https://platform.lunox.work",
      overrideIgnored: true,
      invalid: false,
    },
  );
  assert.deepEqual(resolvePlatformOrigin({ globalValue: "not a url" }), {
    origin: DEFAULT_PLATFORM_ORIGIN,
    overrideIgnored: false,
    invalid: true,
  });
  assert.deepEqual(
    resolvePlatformOrigin({ globalValue: "ftp://files.example.test" }),
    {
      origin: DEFAULT_PLATFORM_ORIGIN,
      overrideIgnored: false,
      invalid: true,
    },
  );
  assert.equal(
    tokenKeyFor("https://api.example.test"),
    "sandboxFactory.token:https://api.example.test",
  );
  assert.notEqual(tokenKeyFor("https://a.test"), tokenKeyFor("https://b.test"));
});

test("the tokens page is on the platform, and only a contributor token is taken", () => {
  assert.equal(DEFAULT_PLATFORM_ORIGIN, "https://platform.lunox.work");
  assert.equal(
    tokensPageUrl("https://platform.lunox.work"),
    "https://platform.lunox.work/contributions#contributor-tokens",
  );
  assert.equal(tokenProblem("lnxc_abc"), null);
  // A workspace API token, or anything else, is not a contributor's.
  assert.match(tokenProblem("lnx_abc") ?? "", /starts with lnxc_/);
  assert.match(tokenProblem("hello") ?? "", /Contributions page/);
});
