import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  chownTree,
  jobCache,
  jobIsolation,
  JOB_UID_MIN,
  killIdentity,
  probeIsolation,
  runAs,
  scanAndKill,
} from "../src/evaluation/isolation.js";
import type { JobIdentity } from "../src/evaluation/isolation.js";

/** This test process's own user: what a non-root run can switch to. */
const self: JobIdentity = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

test("only a root worker isolates jobs, with a uid of its own per job slot", () => {
  const input = { base: 61_000, slots: 2, cacheRoot: "/tmp/jobs" };
  assert.equal(jobIsolation({ ...input, uid: 1000 }), null);
  assert.equal(jobIsolation({ ...input, uid: undefined }), null);
  assert.deepEqual(jobIsolation({ ...input, uid: 0 }), {
    identities: [
      { uid: 61_000, gid: 61_000 },
      { uid: 61_001, gid: 61_001 },
    ],
    cacheRoot: "/tmp/jobs",
  });
  // Never a uid people or services get, such as `node`'s 1000.
  assert.throws(
    () => jobIsolation({ ...input, uid: 0, base: 1000 }),
    /start at 10000/,
  );
  assert.ok(jobIsolation({ ...input, uid: 0, base: JOB_UID_MIN }));
});

test("everything a job uid runs is killed by one more process of that uid", async () => {
  const calls: [readonly string[], JobIdentity][] = [];
  await killIdentity({ uid: 61_000, gid: 61_000 }, async (argv, identity) => {
    calls.push([argv, identity]);
  });
  assert.equal(calls.length, 1);
  const [argv, identity] = calls[0] ?? [[], self];
  assert.deepEqual(identity, { uid: 61_000, gid: 61_000 });
  assert.equal(argv[0], process.execPath);
  assert.match(argv.join(" "), /process\.kill\(-1, 'SIGKILL'\)/);
  // Never the worker's own uid or root: that would take the worker, or
  // the machine, with it.
  const never = async () => assert.fail("must not run");
  await assert.rejects(killIdentity({ uid: 0, gid: 0 }, never), /Refusing/);
  await assert.rejects(killIdentity(self, never), /Refusing/);
  await assert.rejects(killIdentity(self), /Refusing/);
  // When no process of the uid can start (its process limit is held), the
  // worker scans for them itself; a uid neither clears is reported.
  const eagain = async () => {
    throw new Error("spawn EAGAIN");
  };
  const scanned: number[] = [];
  await killIdentity({ uid: 61_000, gid: 61_000 }, eagain, async (uid) => {
    scanned.push(uid);
    return true;
  });
  assert.deepEqual(scanned, [61_000]);
  await assert.rejects(
    killIdentity({ uid: 61_000, gid: 61_000 }, eagain, async () => false),
    /EAGAIN/,
  );
  // Only Linux has a `/proc` to scan; a uid nothing runs as is clear.
  assert.equal(await scanAndKill(1_999_999_999), process.platform === "linux");
  // The runner switches to the identity; this test can only switch to
  // its own.
  const marker = join(await mkdtemp(join(tmpdir(), "run-as-")), "ran");
  assert.equal(
    await runAs(
      [
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(marker)}, ''); process.exit(3)`,
      ],
      self,
    ),
    3,
  );
  assert.equal((await stat(marker)).uid, self.uid);
  await rm(join(marker, ".."), { recursive: true, force: true });
  await assert.rejects(runAs(["/definitely/not/here"], self), /ENOENT/);
});

test("each identity's npm cache is its own, under a root jobs can only traverse", async () => {
  const root = await mkdtemp(join(tmpdir(), "job-caches-"));
  try {
    const cacheRoot = join(root, "jobs");
    const isolation = { identities: [self], cacheRoot };
    const cache = await jobCache(isolation, self);
    assert.equal(cache, join(cacheRoot, String(self.uid)));
    assert.equal((await stat(cacheRoot)).mode & 0o777, 0o711);
    assert.equal((await stat(cache)).mode & 0o777, 0o700);
    // Again, it is found as it was left.
    assert.equal(await jobCache(isolation, self), cache);
    // A link or a file in its place is refused, not followed.
    const linked = { identities: [self], cacheRoot: join(root, "linked") };
    await symlink(cacheRoot, linked.cacheRoot);
    await assert.rejects(jobCache(linked, self), /not a directory/);
    const blocked = { identities: [self], cacheRoot: join(root, "blocked") };
    await mkdir(blocked.cacheRoot);
    await writeFile(join(blocked.cacheRoot, String(self.uid)), "");
    await assert.rejects(jobCache(blocked, self), /not a directory/);
    const unreadable = { identities: [self], cacheRoot: join(root, "x", "y") };
    await assert.rejects(jobCache(unreadable, self), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a staged tree is handed to the job's identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "job-tree-"));
  try {
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "deep", "a.ts"), "");
    await writeFile(join(root, "package.json"), "{}");
    await chownTree(root, self);
    assert.equal((await stat(join(root, "src", "deep", "a.ts"))).uid, self.uid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a root worker checks at startup that it runs processes as each job uid", async () => {
  const isolation = {
    identities: [
      { uid: 61_000, gid: 61_000 },
      { uid: 61_001, gid: 61_001 },
    ],
    cacheRoot: "/tmp/jobs",
  };
  const probed: number[] = [];
  await probeIsolation(isolation, async (argv, identity) => {
    probed.push(identity.uid);
    assert.match(
      argv.join(" "),
      new RegExp(`getuid\\(\\) === ${identity.uid}`),
    );
    return 0;
  });
  assert.deepEqual(probed, [61_000, 61_001]);
  await assert.rejects(
    probeIsolation(isolation, async () => {
      throw new Error("spawn EPERM");
    }),
    /evaluation_isolation_unavailable: .*uid 61000.*EPERM/,
  );
  await assert.rejects(
    probeIsolation(isolation, async () => 1),
    /evaluation_isolation_unavailable: .*did not run as it/,
  );
  // The probe itself, run as this test's own user, passes for it alone.
  await probeIsolation({ identities: [self], cacheRoot: "/tmp/jobs" });
  // It fails for a gid the process cannot switch to, as only root could.
  if (self.uid !== 0)
    await assert.rejects(
      probeIsolation({
        identities: [{ uid: self.uid, gid: self.gid + 1 }],
        cacheRoot: "/tmp/jobs",
      }),
      /evaluation_isolation_unavailable/,
    );
});
