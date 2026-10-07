import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLocalProcessProvider,
  runProcess,
} from "../src/evaluation/local-process.js";

const limits = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };

test("a local job stages files, runs scrubbed processes, reads results and tears down", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  process.env["SANDBOX_TEST_SECRET"] = "leak";
  try {
    const provider = createLocalProcessProvider({ root });
    assert.equal(provider.name, "local-process");
    const job = await provider.create({
      label: "sbv_1/odd label",
      signal: new AbortController().signal,
    });
    assert.equal(job.environment.provider, "local-process");
    assert.match(job.environment.environmentId ?? "", /^node@/);
    assert.equal(job.environment.templateDigest, null);
    await job.stage([
      { path: "dir/hello.txt", text: "hello" },
      {
        path: "script.js",
        text: "console.log(process.env.SANDBOX_TEST_SECRET ?? 'none', process.env.HOME !== undefined, process.env.EXTRA ?? '-'); process.exit(3);",
      },
    ]);
    assert.equal(await job.read("dir/hello.txt"), "hello");
    assert.equal(await job.read("missing.txt"), null);
    const result = await job.exec({
      argv: ["node", "script.js"],
      env: { EXTRA: "x" },
      limits,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout.trim(), "none true x");
    assert.equal(result.timedOut, false);
    const nested = await job.exec({
      argv: ["node", "-e", "console.log(process.cwd().endsWith('dir'))"],
      cwd: "dir",
      limits,
    });
    assert.equal(nested.stdout.trim(), "true");
    await assert.rejects(
      job.stage([{ path: "../escape.txt", text: "" }]),
      /leaves the job/,
    );
    await assert.rejects(
      job.stage([{ path: "/abs.txt", text: "" }]),
      /leaves the job/,
    );
    await assert.rejects(job.read("../etc"), /leaves the job/);
    await assert.rejects(
      job.exec({ argv: ["node", "-v"], cwd: "..", limits }),
      /leaves the job/,
    );
    const directory = join(root, job.id);
    await access(directory);
    await job.destroy();
    await assert.rejects(access(directory));
  } finally {
    delete process.env["SANDBOX_TEST_SECRET"];
    await rm(root, { recursive: true, force: true });
  }
});

test("processes are bounded in time and output, and abort or missing executables surface", async () => {
  const signal = new AbortController().signal;
  const env = { PATH: process.env["PATH"] ?? "" };
  const slow = await runProcess(
    {
      argv: ["node", "-e", "setTimeout(() => {}, 20000)"],
      limits: { timeoutMs: 300, maxOutputBytes: 1024 },
    },
    { cwd: process.cwd(), env, signal },
  );
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.exitCode, 0);
  const loud = await runProcess(
    {
      argv: [
        "node",
        "-e",
        "process.stdout.write('x'.repeat(5000)); process.stderr.write('e'.repeat(50))",
      ],
      limits: { timeoutMs: 10_000, maxOutputBytes: 100 },
    },
    { cwd: process.cwd(), env, signal },
  );
  // One budget across both pipes; which pipe's bytes arrive first is the
  // operating system's choice, so only the total is fixed.
  assert.equal(loud.outputTruncated, true);
  assert.equal(loud.stdout.length + loud.stderr.length, 100);
  assert.match(loud.stdout, /^x*$/);
  assert.match(loud.stderr, /^e*$/);
  assert.equal(loud.exitCode, 0);
  const quiet = await runProcess(
    { argv: ["node", "-e", "process.stderr.write('warn')"], limits },
    { cwd: process.cwd(), env, signal },
  );
  assert.equal(quiet.stderr, "warn");
  await assert.rejects(
    runProcess(
      { argv: ["definitely-not-a-binary-xyz"], limits },
      { cwd: process.cwd(), env, signal },
    ),
    /ENOENT/,
  );
  assert.throws(
    () => runProcess({ argv: [], limits }, { cwd: process.cwd(), env, signal }),
    /needs an executable/,
  );
  const controller = new AbortController();
  const pending = runProcess(
    { argv: ["node", "-e", "setTimeout(() => {}, 20000)"], limits },
    { cwd: process.cwd(), env, signal: controller.signal },
  );
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  const already = new AbortController();
  already.abort(new Error("gone"));
  await assert.rejects(
    createLocalProcessProvider().create({ label: "x", signal: already.signal }),
    /gone/,
  );
  await assert.rejects(
    runProcess(
      { argv: ["node", "-e", "setTimeout(() => {}, 20000)"], limits },
      { cwd: process.cwd(), env, signal: already.signal },
    ),
    /gone/,
  );
});

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("what a command leaves running in its group is stopped when it exits", async () => {
  // A test that starts a server and never stops it: the server would
  // outlive the job, holding its port, after the directory is gone.
  const result = await runProcess(
    {
      argv: [
        "node",
        "-e",
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); c.unref(); console.log(c.pid);",
      ],
      limits: { timeoutMs: 10_000, maxOutputBytes: 1024 },
    },
    {
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.exitCode, 0);
  const pid = Number(result.stdout.trim());
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(alive(pid), false);
});

test("a holder of the output outside the group does not keep the command running", async () => {
  // It left the process group, so neither the timeout nor the group kill
  // reaches it; settling on "close" waited for it for as long as it lived.
  const started = Date.now();
  const result = await runProcess(
    {
      argv: [
        "node",
        "-e",
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' }); c.unref(); console.log(c.pid);",
      ],
      limits: { timeoutMs: 10_000, maxOutputBytes: 1024 },
    },
    {
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      signal: new AbortController().signal,
    },
  );
  const pid = Number(result.stdout.trim());
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});
