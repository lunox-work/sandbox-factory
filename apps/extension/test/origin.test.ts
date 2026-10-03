import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_API_ORIGIN,
  resolveApiOrigin,
  tokenKeyFor,
} from "../src/origin.js";

test("the API origin comes from user settings only, and tokens are bound to it", () => {
  assert.deepEqual(resolveApiOrigin(undefined), {
    origin: DEFAULT_API_ORIGIN,
    overrideIgnored: false,
    invalid: false,
  });
  assert.deepEqual(
    resolveApiOrigin({
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
    resolveApiOrigin({
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
    resolveApiOrigin({
      defaultValue: "http://localhost:4000",
      workspaceFolderValue: "https://evil.example.test",
    }),
    { origin: "http://localhost:4000", overrideIgnored: true, invalid: false },
  );
  assert.deepEqual(resolveApiOrigin({ globalValue: "not a url" }), {
    origin: DEFAULT_API_ORIGIN,
    overrideIgnored: false,
    invalid: true,
  });
  assert.deepEqual(
    resolveApiOrigin({ globalValue: "ftp://files.example.test" }),
    {
      origin: DEFAULT_API_ORIGIN,
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
