import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLocalProcessProvider,
  runProcess,
} from "../src/evaluation/local-process.js";
import { createLockfileStore } from "../src/evaluation/lockfiles.js";

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

const MANIFEST = '{"name":"a","dependencies":{"zod":"4.0.0"}}';
/** What npm prepares for `MANIFEST`: registry tarballs with integrity. */
const LOCKFILE = JSON.stringify({
  name: "a",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "a", dependencies: { zod: "4.0.0" } },
    "node_modules/zod": {
      version: "4.0.0",
      resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
      integrity: "sha512-AbC=",
    },
  },
});
const PREPARE = ["npm", "install", "--package-lock-only", "--ignore-scripts"];

/**
 * Puts an `npm` first on PATH that writes `$LOCK` as the lockfile and
 * prints how it was asked to use the cache, for the provider's jobs
 * created until `restore` runs.
 */
async function fakeNpm(root: string): Promise<() => void> {
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh\nexec "${process.execPath}" -e "require('fs').writeFileSync('package-lock.json', process.env.LOCK); console.log(process.env.npm_config_cache, process.env.npm_config_prefer_offline, process.env.npm_config_prefer_online ?? '-', process.env.npm_config_registry)"\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  return () => {
    process.env["PATH"] = path;
  };
}

test("a dependency set's lockfile, prepared in an empty cache before the project ran, is kept for the next job once the job is over", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const npmCache = join(root, "npm");
  const lockfiles = join(root, "lockfiles");
  const signal = new AbortController().signal;
  const restore = await fakeNpm(root);
  try {
    // A store an older worker kept inside the npm cache is cleared.
    await mkdir(join(npmCache, "_lockfiles"), { recursive: true });
    const provider = createLocalProcessProvider({ root, npmCache, lockfiles });
    const first = await provider.create({ label: "one", signal });
    await first.stage([
      { path: "package.json", text: MANIFEST },
      { path: ".npmrc", text: "engine-strict=true\nignore-scripts=true\n" },
    ]);
    assert.equal(await first.read("package-lock.json"), null);
    const prepared = await first.exec({
      argv: PREPARE,
      env: { LOCK: LOCKFILE },
      limits,
    });
    // Preparation resolves against the registry, in an empty cache of its
    // own rather than the one earlier jobs wrote.
    const [cache = "", ...settings] = prepared.stdout.trim().split(" ");
    assert.deepEqual(settings, [
      "false",
      "true",
      "https://registry.npmjs.org/",
    ]);
    assert.ok(cache.startsWith(join(root, first.id, "prepare-cache-")), cache);
    assert.deepEqual(await readdir(cache), []);
    assert.equal((await stat(cache)).mode & 0o777, 0o700);
    await assert.rejects(access(join(npmCache, "_lockfiles")));
    assert.equal(await first.read("package-lock.json"), LOCKFILE);
    // The rest of the job runs off the cache, and may rewrite the
    // lockfile; what it writes is not what is kept.
    const ran = await first.exec({
      argv: [
        "node",
        "-e",
        "require('fs').writeFileSync('package-lock.json', 'tampered'); console.log(process.env.npm_config_prefer_offline, process.env.npm_config_cache, process.env.TMPDIR, process.env.TMP, process.env.TEMP)",
      ],
      limits,
    });
    const tmp = join(root, first.id, "tmp");
    assert.equal(ran.stdout.trim(), `true ${npmCache} ${tmp} ${tmp} ${tmp}`);
    assert.equal((await stat(tmp)).mode & 0o777, 0o700);
    assert.equal(await first.read("package-lock.json"), "tampered");
    // Kept only once the job is over.
    await assert.rejects(access(lockfiles));
    await first.destroy();

    // The same dependencies start from it, whatever the project is called.
    const second = await provider.create({ label: "two", signal });
    await second.stage([
      {
        path: "package.json",
        text: '{"name":"b","dependencies":{"zod":"4.0.0"}}',
      },
    ]);
    assert.equal(await second.read("package-lock.json"), LOCKFILE);
    await second.destroy();

    // Others, a manifest that does not parse, a lockfile staged with them,
    // or settings that would resolve differently do not.
    const third = await provider.create({ label: "three", signal });
    await third.stage([
      { path: "package.json", text: '{"dependencies":{"zod":"4.1.0"}}' },
    ]);
    assert.equal(await third.read("package-lock.json"), null);
    const garbled = await provider.create({ label: "garbled", signal });
    await garbled.stage([{ path: "package.json", text: "{" }]);
    assert.equal(await garbled.read("package-lock.json"), null);
    const fourth = await provider.create({ label: "four", signal });
    await fourth.stage([
      { path: "package.json", text: MANIFEST },
      { path: "package-lock.json", text: "its own" },
    ]);
    assert.equal(await fourth.read("package-lock.json"), "its own");
    const dated = await provider.create({ label: "dated", signal });
    await dated.stage([
      { path: "package.json", text: MANIFEST },
      { path: ".npmrc", text: "before=2019-01-01\n" },
    ]);
    assert.equal(await dated.read("package-lock.json"), null);
    for (const job of [third, garbled, fourth, dated]) await job.destroy();
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a lockfile read after the project ran, or one that does not fit, is not kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const lockfiles = join(root, "lockfiles");
  const signal = new AbortController().signal;
  const restore = await fakeNpm(root);
  try {
    const provider = createLocalProcessProvider({ root, lockfiles });
    const late = await provider.create({ label: "late", signal });
    await late.stage([{ path: "package.json", text: MANIFEST }]);
    await late.exec({ argv: ["node", "-e", ""], limits });
    await late.exec({ argv: PREPARE, env: { LOCK: LOCKFILE }, limits });
    assert.equal(await late.read("package-lock.json"), LOCKFILE);
    await late.destroy();
    const foreign = await provider.create({ label: "foreign", signal });
    await foreign.stage([{ path: "package.json", text: MANIFEST }]);
    const elsewhere = LOCKFILE.replace(
      "https://registry.npmjs.org/",
      "https://evil.example/",
    );
    await foreign.exec({ argv: PREPARE, env: { LOCK: elsewhere }, limits });
    assert.equal(await foreign.read("package-lock.json"), elsewhere);
    await foreign.destroy();
    await assert.rejects(access(lockfiles));
    // Written into the store by someone else, it is discarded on read.
    const store = createLockfileStore(lockfiles);
    assert.equal(await store.put(MANIFEST, LOCKFILE), true);
    const [name] = await readdir(lockfiles);
    await writeFile(join(lockfiles, name ?? ""), elsewhere);
    const next = await provider.create({ label: "next", signal });
    await next.stage([{ path: "package.json", text: MANIFEST }]);
    assert.equal(await next.read("package-lock.json"), null);
    assert.deepEqual(await readdir(lockfiles), []);
    await next.destroy();
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("staging in several calls decides on everything staged, so the project's lockfile is never replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const lockfiles = join(root, "lockfiles");
  const signal = new AbortController().signal;
  try {
    assert.equal(
      await createLockfileStore(lockfiles).put(MANIFEST, LOCKFILE),
      true,
    );
    const provider = createLocalProcessProvider({ root, lockfiles });
    // The project's lockfile, staged after its manifest, stays.
    const own = await provider.create({ label: "own", signal });
    await own.stage([{ path: "./package.json", text: MANIFEST }]);
    assert.equal(await own.read("package-lock.json"), LOCKFILE);
    await own.stage([{ path: "package-lock.json", text: "its own" }]);
    await own.stage([{ path: "src/a.ts", text: "" }]);
    assert.equal(await own.read("package-lock.json"), "its own");
    // Another manifest, or settings that resolve differently, staged
    // later, take the store's lockfile back out.
    const changed = await provider.create({ label: "changed", signal });
    await changed.stage([{ path: "package.json", text: MANIFEST }]);
    await changed.stage([
      { path: "package.json", text: '{"dependencies":{"zod":"4.1.0"}}' },
    ]);
    assert.equal(await changed.read("package-lock.json"), null);
    const dated = await provider.create({ label: "dated", signal });
    await dated.stage([{ path: "package.json", text: MANIFEST }]);
    await dated.stage([{ path: ".npmrc", text: "before=2019-01-01\n" }]);
    assert.equal(await dated.read("package-lock.json"), null);
    for (const job of [own, changed, dated]) await job.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a job's own files are read back without following links or waiting on pipes, and it is staged once", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const signal = new AbortController().signal;
  try {
    const job = await createLocalProcessProvider({ root }).create({
      label: "links",
      signal,
    });
    await job.stage([
      { path: "a.txt", text: "a" },
      { path: "b.txt", text: "b" },
    ]);
    await writeFile(join(root, "secret"), "secret");
    const result = await job.exec({
      argv: [
        "node",
        "-e",
        `const fs = require('fs'); fs.symlinkSync(${JSON.stringify(join(root, "secret"))}, 'link'); fs.mkdirSync('d'); fs.symlinkSync('..', 'd/up'); fs.symlinkSync(${JSON.stringify(root)}, 'out'); fs.linkSync('b.txt', 'hard'); require('child_process').execFileSync('mkfifo', ['pipe']);`,
      ],
      limits,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await job.read("link"), null);
    assert.equal(await job.read("out/secret"), null);
    assert.equal(await job.read("d/up/a.txt"), "a");
    assert.equal(await job.read("pipe"), null);
    // A hard link may name a file outside the job; neither name is read.
    assert.equal(await job.read("hard"), null);
    assert.equal(await job.read("b.txt"), null);
    assert.equal(await job.read("d"), null);
    await assert.rejects(
      job.stage([{ path: "later.txt", text: "" }]),
      /staged before it runs/,
    );
    await job.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an isolated job runs as its identity, which no other job holds until it is swept and released", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const signal = new AbortController().signal;
  const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  const swept: number[] = [];
  const warnings: string[] = [];
  try {
    const provider = createLocalProcessProvider({
      root,
      warn: (line) => warnings.push(line),
      isolation: {
        identities: [self],
        cacheRoot: join(root, "jobs"),
        sweep: async (identity) => {
          swept.push(identity.uid);
        },
      },
    });
    assert.deepEqual(warnings, []);
    const job = await provider.create({ label: "isolated", signal });
    assert.deepEqual(swept, [self.uid]);
    const directory = join(root, job.id);
    assert.equal((await stat(directory)).mode & 0o777, 0o711);
    assert.equal((await stat(join(directory, "work"))).mode & 0o777, 0o700);
    await job.stage([{ path: "src/a.txt", text: "a" }]);
    assert.equal((await stat(join(directory, "work", "src"))).uid, self.uid);
    const result = await job.exec({
      argv: [
        "node",
        "-e",
        "console.log(process.getuid(), process.env.npm_config_cache, process.env.TMPDIR, process.env.npm_config_logs_dir)",
      ],
      limits,
    });
    // npm logs into the job's temporary directory, not the cache that
    // outlives it.
    assert.equal(
      result.stdout.trim(),
      `${self.uid} ${join(root, "jobs", String(self.uid))} ${join(directory, "tmp")} ${join(directory, "tmp", "npm-logs")}`,
    );
    assert.equal((await stat(join(directory, "tmp"))).mode & 0o777, 0o700);
    // One identity per job at once.
    await assert.rejects(
      provider.create({ label: "second", signal }),
      /identity is in use/,
    );
    await job.destroy();
    assert.deepEqual(swept, [self.uid, self.uid]);
    // A second teardown does nothing, and gives the identity back once.
    await job.destroy();
    assert.deepEqual(swept, [self.uid, self.uid]);
    const again = await provider.create({ label: "again", signal });
    await assert.rejects(
      provider.create({ label: "twice", signal }),
      /identity is in use/,
    );
    await again.destroy();
    // A job that cannot be prepared gives its identity back.
    const failing = createLocalProcessProvider({
      root,
      isolation: {
        identities: [self],
        cacheRoot: join(root, "missing", "jobs"),
        sweep: async () => {},
      },
    });
    await assert.rejects(failing.create({ label: "x", signal }), /ENOENT/);
    await assert.rejects(failing.create({ label: "x", signal }), /ENOENT/);
    await assert.rejects(
      createLocalProcessProvider({
        root: join(root, "nowhere"),
        isolation: { identities: [self], cacheRoot: root },
      }).create({ label: "x", signal }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an identity whose sweep failed is held back, and swept again before another job runs as it", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-eval-"));
  const signal = new AbortController().signal;
  const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  const warnings: string[] = [];
  let failing = false;
  try {
    const provider = createLocalProcessProvider({
      root,
      warn: (line) => warnings.push(line),
      isolation: {
        identities: [self],
        cacheRoot: join(root, "jobs"),
        sweep: async () => {
          if (failing) throw new Error("spawn EAGAIN");
        },
      },
    });
    const job = await provider.create({ label: "bomb", signal });
    failing = true;
    // The teardown says it failed, and still removes the directory.
    await assert.rejects(job.destroy(), /EAGAIN/);
    await assert.rejects(access(join(root, job.id)));
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? "",
      new RegExp(`^evaluation_job_identity_quarantined: uid ${self.uid} `),
    );
    // While its sweep keeps failing, no job runs as it.
    await assert.rejects(provider.create({ label: "next", signal }), /EAGAIN/);
    assert.equal(warnings.length, 2);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith("sandbox-eval-")),
      [],
    );
    // Once a sweep clears it, it is a job's again, and only one's.
    failing = false;
    const next = await provider.create({ label: "next", signal });
    await assert.rejects(
      provider.create({ label: "other", signal }),
      /identity is in use/,
    );
    await next.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker that cannot isolate jobs says so once", () => {
  const warnings: string[] = [];
  createLocalProcessProvider({ warn: (line) => warnings.push(line) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /^evaluation_jobs_not_isolated: /);
});
