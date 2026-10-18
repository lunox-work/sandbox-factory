/**
 * Which user an evaluation job's processes run as. A worker running as
 * root (the Linux dev container) runs each job as an unprivileged uid of
 * its own, so a job cannot read the worker's process environment through
 * `/proc/<pid>/environ`, its source cache or the lockfile store, another
 * job's files, nor signal it. That is all it keeps out of reach: the job
 * still reads whatever is world-readable on the machine (in compose, the
 * checkout the worker builds from, minus the env files compose masks) and
 * shares its network, from which compose's development Postgres and
 * object store answer with credentials anyone can read. Any other worker
 * cannot switch users: jobs then run as the worker itself, and it says so
 * once at startup.
 *
 * One uid per concurrent job, from a small range starting at
 * `EVALUATION_JOB_UID` (gid the same number; neither needs a passwd
 * entry), so that after a job everything its uid still runs can be killed
 * without touching another job: processes that left the job's process
 * group with `setsid` escape the group kill, not this one. The range is
 * as wide as the worker's job limit (`EVALUATION_JOBS_MAX`), which
 * `limitJobs` enforces before a job is created.
 */

import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  readdir,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * The lowest uid a job may run as: above the ones distributions hand to
 * people and services (`node` is 1000), so none of them shares a job's
 * uid and is killed with it.
 */
export const JOB_UID_MIN = 10_000;

export interface JobIdentity {
  readonly uid: number;
  readonly gid: number;
}

export interface JobIsolation {
  /** One per job that may run at once. */
  readonly identities: readonly JobIdentity[];
  /**
   * Where each identity's npm cache lives, as `<root>/<uid>`: a directory
   * the worker owns, outside its home, which jobs may traverse but not
   * list or write.
   */
  readonly cacheRoot: string;
  /** Kills every process an identity still runs; `killIdentity` by default. */
  readonly sweep?: (identity: JobIdentity) => Promise<void>;
}

export const ISOLATION_WARNING =
  "evaluation_jobs_not_isolated: the worker is not root, so evaluation jobs run as the worker's own user and can read its files and environment";

/**
 * The isolation a worker running as `uid` gives its jobs: a uid each from
 * `base` for `slots` jobs when it is root, none otherwise.
 */
export function jobIsolation(input: {
  readonly uid: number | undefined;
  readonly base: number;
  readonly slots: number;
  readonly cacheRoot: string;
}): JobIsolation | null {
  if (input.uid !== 0) return null;
  if (input.base < JOB_UID_MIN)
    throw new Error(`Job uids start at ${JOB_UID_MIN} or above.`);
  return {
    identities: Array.from({ length: input.slots }, (_, index) => ({
      uid: input.base + index,
      gid: input.base + index,
    })),
    cacheRoot: input.cacheRoot,
  };
}

/** Rounds of `/proc` scanning before a uid that keeps forking is given up on. */
const SCAN_ROUNDS = 50;

/**
 * Kills every process of `uid` by scanning `/proc`, round after round
 * until one finds none: what the root worker falls back to when it
 * cannot start a process of that uid (a fork bomb holds its process
 * limit). A killed process forks no more, so the rounds shrink. True when
 * none is left; false off Linux, where there is no `/proc` to scan.
 */
export async function scanAndKill(uid: number): Promise<boolean> {
  for (let round = 0; round < SCAN_ROUNDS; round += 1) {
    let pids: string[];
    try {
      pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    } catch {
      return false;
    }
    let found = 0;
    for (const pid of pids) {
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
        () => "",
      );
      // Real, effective, saved and filesystem uid: any of them is the job's.
      // A zombie runs nothing and waits only to be reaped.
      const uids = /^Uid:\s+(.*)$/m.exec(status)?.[1]?.split(/\s+/) ?? [];
      if (!uids.includes(String(uid)) || /^State:\s+Z/m.test(status)) continue;
      found += 1;
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    if (found === 0) return true;
  }
  return false;
}

/**
 * Kills every process `identity` runs, by asking one more process of that
 * uid to `kill(-1, SIGKILL)`: the kernel signals all of the uid's
 * processes in one pass, so none can fork its way out the way a scan of
 * `/proc` followed by kills would let it. When that process cannot start,
 * the scan (`scanAndKill`) is tried instead; a uid neither clears is
 * reported by throwing. Refuses the worker's own uid and root, for which
 * that would kill the worker or the machine.
 */
export async function killIdentity(
  identity: JobIdentity,
  run: (
    argv: readonly string[],
    identity: JobIdentity,
  ) => Promise<unknown> = runAs,
  scan: (uid: number) => Promise<boolean> = scanAndKill,
): Promise<void> {
  if (identity.uid === 0 || identity.uid === process.getuid?.())
    throw new Error(`Refusing to kill every process of uid ${identity.uid}.`);
  try {
    await run(
      [process.execPath, "-e", "try { process.kill(-1, 'SIGKILL') } catch {}"],
      identity,
    );
  } catch (error) {
    if (!(await scan(identity.uid))) throw error;
  }
}

/** Runs `argv` as `identity`, from `/`; resolves with its exit code. */
export function runAs(
  argv: readonly string[],
  identity: JobIdentity,
): Promise<number | null> {
  const [executable, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(executable ?? "", args, {
      cwd: "/",
      uid: identity.uid,
      gid: identity.gid,
      env: {},
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

/**
 * Checks, once at startup, that the worker can run a process as each job
 * identity and that it then runs as that uid and gid: a root worker that
 * cannot is misconfigured, and is better stopped than left failing every
 * job or running them as root.
 */
export async function probeIsolation(
  isolation: JobIsolation,
  run: (
    argv: readonly string[],
    identity: JobIdentity,
  ) => Promise<number | null> = runAs,
): Promise<void> {
  for (const identity of isolation.identities) {
    const code = await run(
      [
        process.execPath,
        "-e",
        `process.exit(process.getuid() === ${identity.uid} && process.getgid() === ${identity.gid} ? 0 : 1)`,
      ],
      identity,
    ).catch((error: unknown) => {
      throw new Error(
        `evaluation_isolation_unavailable: cannot run a process as uid ${identity.uid}: ${String(error)}`,
      );
    });
    if (code !== 0)
      throw new Error(
        `evaluation_isolation_unavailable: a process started for uid ${identity.uid} did not run as it`,
      );
  }
}

/**
 * A directory owned by `owner` and nobody else's to replace: created when
 * absent, refused when it is a link or someone else's.
 */
async function ownedDirectory(
  path: string,
  owner: JobIdentity,
  mode: number,
): Promise<void> {
  await mkdir(path, { mode }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`${path} is not a directory.`);
  if (stats.uid !== owner.uid) {
    // Only ever just created by the worker for the identity; a directory
    // another user made first is refused rather than adopted.
    if (stats.uid !== process.getuid?.())
      throw new Error(`${path} belongs to another user.`);
    await chown(path, owner.uid, owner.gid);
  }
  await chmod(path, mode);
}

/**
 * The identity's npm cache, `<cacheRoot>/<uid>`: the root is the
 * worker's, traversable only; the cache is the identity's alone.
 */
export async function jobCache(
  isolation: JobIsolation,
  identity: JobIdentity,
): Promise<string> {
  const self = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
  await ownedDirectory(isolation.cacheRoot, self, 0o711);
  const cache = join(isolation.cacheRoot, String(identity.uid));
  await ownedDirectory(cache, identity, 0o700);
  return cache;
}

/**
 * Gives a tree the worker staged to the job's identity, so its processes
 * can write where a project expects to. Links are changed, not followed;
 * the job has not run yet, so there are none it made.
 */
export async function chownTree(
  root: string,
  identity: JobIdentity,
): Promise<void> {
  await chown(root, identity.uid, identity.gid);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await chownTree(path, identity);
    else await lchown(path, identity.uid, identity.gid);
  }
}
