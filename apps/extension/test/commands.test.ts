import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskCommands } from "../src/commands.js";
import { fakeHost } from "./fake-host.js";
import { descriptor } from "./fixtures.js";

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
    { name: "Lunox: install", cwd: "/work/task", command: "npm ci" },
    { name: "Lunox: run", cwd: "/work/task", command: "npm run dev" },
    { name: "Lunox: test", cwd: "/work/task", command: "npm test" },
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
  assert.match(none.messages[0]?.text ?? "", /open a project folder/);
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

test("open task opens a project folder on disk, and executes no scripts", async () => {
  const local = fakeHost({ folderPicks: ["/work/task"], files: taskFiles });
  await createTaskCommands(local.host).openTask();
  assert.deepEqual(local.opened, [{ path: "/work/task", newWindow: false }]);
  assert.deepEqual(local.terminals, []);
  // Opening reloads the window: the task is described when it starts.
  assert.deepEqual(local.messages, []);
  assert.equal(local.state.remembered, "/work/task");
  // A folder already open is not reopened; it is described at once.
  const already = fakeHost({
    folders: ["/work/task"],
    folderPicks: ["/work/task"],
    files: taskFiles,
  });
  await createTaskCommands(already.host).openTask();
  assert.deepEqual(already.opened, []);
  assert.equal(already.state.remembered, undefined);
  assert.equal(already.messages[0]?.level, "info");
  const plain = fakeHost({
    folders: ["/work/plain"],
    folderPicks: ["/work/plain"],
  });
  await createTaskCommands(plain.host).openTask();
  assert.equal(plain.messages[0]?.level, "warn");
  // The prompt can be dismissed.
  const dismissed = fakeHost({ folderPicks: [undefined] });
  await createTaskCommands(dismissed.host).openTask();
  assert.deepEqual(dismissed.opened, []);
  assert.deepEqual(dismissed.messages, []);
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
