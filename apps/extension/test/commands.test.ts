import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_CLONE, OPEN_LOCAL, createTaskCommands } from "../src/commands.js";
import type { Host } from "../src/host.js";
import { descriptor } from "./fixtures.js";

interface FakeHostOptions {
  folders?: string[];
  trusted?: boolean;
  files?: Record<string, string>;
  picks?: (string | undefined)[];
  inputs?: (string | undefined)[];
  folderPicks?: (string | undefined)[];
  cloneError?: string;
  remembered?: string;
}

function fakeHost(options: FakeHostOptions = {}) {
  const log: string[] = [];
  const messages: { level: string; text: string }[] = [];
  const terminals: { name: string; cwd: string; command: string }[] = [];
  const clones: { url: string; destination: string }[] = [];
  const opened: string[] = [];
  const picks = [...(options.picks ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const folderPicks = [...(options.folderPicks ?? [])];
  const files = options.files ?? {};
  const state: { remembered: string | undefined } = {
    remembered: options.remembered,
  };
  const host: Host = {
    workspaceFolders: () => options.folders ?? [],
    isTrusted: () => options.trusted ?? true,
    readFile: async (path) => files[path] ?? null,
    pick: async () => picks.shift(),
    input: async () => inputs.shift(),
    pickFolder: async () => folderPicks.shift(),
    clone: async (url, destination) => {
      if (options.cloneError !== undefined) throw new Error(options.cloneError);
      clones.push({ url, destination });
      files[`${destination}/sandbox-task.json`] = JSON.stringify(descriptor);
    },
    openFolder: async (path) => {
      opened.push(path);
    },
    rememberOpened: async (folder) => {
      state.remembered = folder;
    },
    openedFolder: () => state.remembered,
    runInTerminal: (name, cwd, command) =>
      terminals.push({ name, cwd, command }),
    info: (text) => messages.push({ level: "info", text }),
    warn: (text) => messages.push({ level: "warn", text }),
    error: (text) => messages.push({ level: "error", text }),
    log: (line) => log.push(line),
  };
  return { host, log, messages, terminals, clones, opened, state };
}

const taskFiles = {
  "/work/task/sandbox-task.json": JSON.stringify(descriptor),
};

test("scripts run only by explicit command, in a trusted workspace, with the fixed command lines", async () => {
  const f = fakeHost({
    folders: ["/work/other", "/work/task"],
    files: taskFiles,
  });
  const commands = createTaskCommands(f.host);
  await commands.installDependencies();
  await commands.runApp();
  await commands.runTests();
  assert.deepEqual(f.terminals, [
    { name: "sandbox-factory: install", cwd: "/work/task", command: "npm ci" },
    { name: "sandbox-factory: run", cwd: "/work/task", command: "npm run dev" },
    { name: "sandbox-factory: test", cwd: "/work/task", command: "npm test" },
  ]);
  assert.equal(f.messages.length, 0);
  const untrusted = fakeHost({
    folders: ["/work/task"],
    files: taskFiles,
    trusted: false,
  });
  await createTaskCommands(untrusted.host).runTests();
  assert.deepEqual(untrusted.terminals, []);
  assert.match(untrusted.messages[0]?.text ?? "", /not trusted/);
  // A tampered descriptor never yields a command.
  const tampered = fakeHost({
    folders: ["/work/task"],
    files: {
      "/work/task/sandbox-task.json": JSON.stringify({
        ...descriptor,
        commands: { ...descriptor.commands, test: "rm -rf /" },
      }),
    },
  });
  await createTaskCommands(tampered.host).runTests();
  assert.deepEqual(tampered.terminals, []);
  assert.match(tampered.messages[0]?.text ?? "", /not a task descriptor/);
  const none = fakeHost({ folders: [] });
  await createTaskCommands(none.host).runTests();
  assert.match(none.messages[0]?.text ?? "", /open a task folder/);
  const missing = fakeHost({ folders: ["/work/plain"] });
  await createTaskCommands(missing.host).runTests();
  assert.match(missing.messages[0]?.text ?? "", /No sandbox-task.json/);
});

test("show task reports the descriptor without running anything", async () => {
  const f = fakeHost({ folders: ["/work/task"], files: taskFiles });
  await createTaskCommands(f.host).showTask();
  assert.deepEqual(f.terminals, []);
  assert.equal(f.messages[0]?.level, "info");
  assert.match(f.messages[0]?.text ?? "", /Fix the widget \(v2, M\)/);
  assert.ok(f.log.some((line) => line.includes("editable: src/app.ts")));
  assert.ok(
    f.log.some((line) => line.includes("test: tests/public/spec.test.ts")),
  );
  const missing = fakeHost({ folders: ["/work/plain"] });
  await createTaskCommands(missing.host).showTask();
  assert.equal(missing.messages[0]?.level, "error");
});

test("open task clones a URL into a chosen folder or opens a local clone, and executes no scripts", async () => {
  const cloned = fakeHost({
    picks: [OPEN_CLONE],
    inputs: ["https://github.com/acme-org/task-repo.git"],
    folderPicks: ["/work"],
  });
  await createTaskCommands(cloned.host).openTask();
  assert.deepEqual(cloned.clones, [
    {
      url: "https://github.com/acme-org/task-repo.git",
      destination: "/work/task-repo",
    },
  ]);
  assert.deepEqual(cloned.opened, ["/work/task-repo"]);
  assert.deepEqual(cloned.terminals, []);
  // Opening reloads the window: the task is described when it starts.
  assert.deepEqual(cloned.messages, []);
  assert.equal(cloned.state.remembered, "/work/task-repo");
  const local = fakeHost({
    picks: [OPEN_LOCAL],
    folderPicks: ["/work/task"],
    files: taskFiles,
  });
  await createTaskCommands(local.host).openTask();
  assert.deepEqual(local.opened, ["/work/task"]);
  assert.equal(local.state.remembered, "/work/task");
  // A folder already open is not reopened; it is described at once.
  const already = fakeHost({
    folders: ["/work/task"],
    picks: [OPEN_LOCAL],
    folderPicks: ["/work/task"],
    files: taskFiles,
  });
  await createTaskCommands(already.host).openTask();
  assert.deepEqual(already.opened, []);
  assert.equal(already.state.remembered, undefined);
  assert.equal(already.messages[0]?.level, "info");
  const plain = fakeHost({
    folders: ["/work/plain"],
    picks: [OPEN_LOCAL],
    folderPicks: ["/work/plain"],
  });
  await createTaskCommands(plain.host).openTask();
  assert.equal(plain.messages[0]?.level, "warn");
  const badUrl = fakeHost({ picks: [OPEN_CLONE], inputs: ["not a url"] });
  await createTaskCommands(badUrl.host).openTask();
  assert.deepEqual(badUrl.clones, []);
  assert.match(badUrl.messages[0]?.text ?? "", /Expected an https/);
  const failed = fakeHost({
    picks: [OPEN_CLONE],
    inputs: ["https://github.com/acme-org/task-repo"],
    folderPicks: ["/work"],
    cloneError: "network down",
  });
  await createTaskCommands(failed.host).openTask();
  assert.deepEqual(failed.opened, []);
  assert.match(failed.messages[0]?.text ?? "", /clone failed: network down/);
  // Every prompt can be dismissed.
  for (const options of [
    { picks: [undefined] },
    { picks: [OPEN_LOCAL], folderPicks: [undefined] },
    { picks: [OPEN_CLONE], inputs: [undefined] },
    {
      picks: [OPEN_CLONE],
      inputs: ["https://github.com/a/b"],
      folderPicks: [undefined],
    },
  ] as FakeHostOptions[]) {
    const dismissed = fakeHost(options);
    await createTaskCommands(dismissed.host).openTask();
    assert.deepEqual(dismissed.opened, []);
    assert.deepEqual(dismissed.clones, []);
    assert.deepEqual(dismissed.messages, []);
  }
});

test("after the reopen, the task is described once and the note is cleared", async () => {
  const reopened = fakeHost({
    folders: ["/work/task"],
    files: taskFiles,
    remembered: "/work/task",
  });
  const commands = createTaskCommands(reopened.host);
  await commands.announceOpened();
  assert.equal(reopened.messages[0]?.level, "info");
  assert.match(reopened.messages[0]?.text ?? "", /Fix the widget/);
  assert.equal(reopened.state.remembered, undefined);
  await commands.announceOpened();
  assert.equal(reopened.messages.length, 1);
  // A note for a folder this window did not open is dropped silently.
  const elsewhere = fakeHost({
    folders: ["/work/other"],
    remembered: "/work/task",
  });
  await createTaskCommands(elsewhere.host).announceOpened();
  assert.deepEqual(elsewhere.messages, []);
  assert.equal(elsewhere.state.remembered, undefined);
});
