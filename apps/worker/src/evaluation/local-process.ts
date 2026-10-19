/**
 * The development evaluation provider: a fresh temporary directory and
 * child processes with a scrubbed environment.
 *
 * It satisfies the adapter contract (fresh job, staged inputs, bounded
 * execution, teardown) so the build and the fixture round trip work
 * without a hosted account, and it is what compose runs. It is **not** an
 * isolation boundary: the processes share the worker's kernel and network,
 * and can read whatever their user can. A root worker runs each job as an
 * unprivileged uid of its own (`isolation.ts`), which keeps the worker's
 * process environment, caches and lockfile store and other jobs' files out
 * of reach, though not what the machine leaves world-readable or its
 * network, and lets everything a job left running be killed and what it
 * left in shared temporary directories be removed; any other worker runs
 * jobs as itself.
 * Hosted evaluation of contributor code needs a provider that meets
 * Decision 5 of the sandbox plan; this one records itself as
 * `local-process` so no record can mistake it for one, and the worker
 * refuses it under `NODE_ENV=production`.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { EVALUATION_LIMITS } from "sandbox-factory";
import type {
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationJob,
  EvaluationProvider,
} from "sandbox-factory";
import {
  chownTree,
  ISOLATION_WARNING,
  jobCache,
  sweepIdentity,
} from "./isolation.js";
import type { JobIdentity, JobIsolation } from "./isolation.js";
import {
  createLockfileStore,
  isLockfilePreparation,
  npmrcIsHarmless,
} from "./lockfiles.js";
import type { LockfileStore } from "./lockfiles.js";

export interface LocalProcessOptions {
  /** Where job directories are created; the OS temp directory by default. */
  readonly root?: string;
  /**
   * The npm cache every job shares when jobs run as the worker, outside
   * any job's directory. A directory of this provider's own under the OS
   * temp directory by default, made once and not at a name another user
   * could guess. Isolated jobs use their identity's cache instead.
   */
  readonly npmCache?: string;
  /**
   * The lockfiles kept for each dependency set (`lockfiles.ts`): the
   * worker's alone, never inside a job's npm cache. A directory of this
   * provider's own under the OS temp directory by default.
   */
  readonly lockfiles?: string;
  /** The uids jobs run as; null or absent runs them as the worker. */
  readonly isolation?: JobIsolation | null;
  /**
   * Told what an operator should know: once, at creation, when jobs run
   * as the worker, and whenever an identity is held back because what it
   * ran could not be killed.
   */
  readonly warn?: (line: string) => void;
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || isAbsolute(path))
    throw new Error(`Path ${path} leaves the job directory.`);
  return absolute;
}

/** How long a finished command's output pipes are read before closing. */
const PIPE_DRAIN_MS = 250;

export function runProcess(
  command: EvaluationCommand,
  options: {
    cwd: string;
    env: Record<string, string>;
    signal: AbortSignal;
    /** The user the process runs as; the worker's own when absent. */
    identity?: JobIdentity | null;
  },
): Promise<EvaluationExecResult> {
  const [executable, ...args] = command.argv;
  if (executable === undefined)
    throw new Error("A command needs an executable.");
  const limits = command.limits ?? EVALUATION_LIMITS;
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...options.env, ...(command.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(options.identity
        ? { uid: options.identity.uid, gid: options.identity.gid }
        : {}),
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    const collect = (chunk: Buffer, isStdout: boolean) => {
      const room = limits.maxOutputBytes - bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk
        .subarray(0, Math.min(room, chunk.length))
        .toString("utf8");
      bytes += chunk.length;
      if (chunk.length > room) truncated = true;
      if (isStdout) stdout += slice;
      else stderr += slice;
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    /*
      Settled once, on the first of: the process failing to start, the
      run being aborted, or the process exiting. Not on "close": that waits
      for every holder of the output pipes, and a grandchild that left the
      process group holds them for as long as it lives, past any timeout or
      abort, so the build would never end.
    */
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      outcome();
    };
    const abort = () => {
      stop();
      settle(() => reject(options.signal.reason));
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.on("error", (error) => {
      clearTimeout(killTimer);
      settle(() => reject(error));
    });
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      // What the command left running in its group goes with it: a server
      // a test started and never stopped would otherwise outlive the job,
      // holding its port, after the directory is removed.
      kill("SIGKILL");
      // Output still in the pipes is read for a moment; a holder outside
      // the group is not waited for.
      const drained = Promise.all(
        [child.stdout, child.stderr].map(
          (stream) =>
            new Promise<void>((done) => {
              if (stream.readableEnded || stream.destroyed) done();
              else stream.once("close", () => done());
            }),
        ),
      );
      const cap = new Promise<void>((done) => {
        setTimeout(done, PIPE_DRAIN_MS).unref();
      });
      void Promise.race([drained, cap]).then(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() =>
          resolvePromise({
            exitCode: code,
            timedOut,
            outputTruncated: truncated,
            stdout,
            stderr,
            durationMs: Date.now() - started,
          }),
        );
      });
    });
  });
}

/** Past this, a file a job left is not read back. */
const READ_MAX_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A regular file under `work`, or null. A job's processes own its
 * directory, so a path may be a link out of it, a hard link to a file
 * elsewhere, a pipe that never yields, or a file that grows while it is
 * read, and may be swapped between a check and the open: none is followed,
 * waited on or read past the cap, whatever user reads it. What is opened
 * is checked rather than the path: a single-linked regular file of
 * `owner` (the job's uid, or the worker's when jobs run as it), and on
 * Linux one whose open descriptor still resolves inside `work`.
 */
async function readInside(
  work: string,
  path: string,
  owner: number | undefined,
): Promise<string | null> {
  const absolute = inside(work, path);
  let handle;
  let root: string;
  try {
    root = await realpath(work);
    const within = relative(root, await realpath(dirname(absolute)));
    if (within.startsWith("..") || isAbsolute(within)) return null;
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (owner !== undefined && stats.uid !== owner) ||
      stats.size > READ_MAX_BYTES
    )
      return null;
    if (process.platform === "linux") {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`).catch(
        () => null,
      );
      const rel = opened === null ? ".." : relative(root, opened);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    }
    // Read to the cap and no further, however large the file has grown
    // since it was measured.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const room = READ_MAX_BYTES + 1 - total;
      const { bytesRead, buffer } = await handle.read(
        Buffer.alloc(Math.min(READ_CHUNK_BYTES, room)),
        0,
        Math.min(READ_CHUNK_BYTES, room),
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > READ_MAX_BYTES) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function createLocalProcessProvider(
  options: LocalProcessOptions = {},
): EvaluationProvider {
  const isolation = options.isolation ?? null;
  if (isolation === null) options.warn?.(ISOLATION_WARNING);
  // The identities' npm caches outlive their sweeps; `jobCache` prunes them.
  const keep = isolation === null ? [] : [isolation.cacheRoot];
  const sweep =
    isolation?.sweep ??
    ((identity: JobIdentity) => sweepIdentity(identity, keep));
  /** Identities no job holds; `limitJobs` keeps demand within them. */
  const free = [...(isolation?.identities ?? [])];
  /**
   * Identities whose sweep failed, so something of theirs may still run:
   * never handed out as clean, only taken when none is free, and swept
   * again before a job runs as them.
   */
  const quarantined: JobIdentity[] = [];
  const quarantine = (identity: JobIdentity, error: unknown) => {
    quarantined.push(identity);
    options.warn?.(
      `evaluation_job_identity_quarantined: uid ${identity.uid} may still run processes (${String(error)}); it is swept again before another job runs as it`,
    );
  };
  let sharedCache: Promise<string> | undefined;
  const npmCacheOf = () =>
    (sharedCache ??= (async () => {
      if (options.npmCache === undefined)
        return mkdtemp(join(tmpdir(), "sandbox-factory-npm-cache-"));
      // Where lockfiles were kept before the store moved out of the cache
      // jobs write; nothing reads it now.
      await rm(join(options.npmCache, "_lockfiles"), {
        recursive: true,
        force: true,
      });
      return options.npmCache;
    })());
  let lockfileStore: Promise<LockfileStore> | undefined;
  const storeOf = () =>
    (lockfileStore ??= (
      options.lockfiles !== undefined
        ? Promise.resolve(options.lockfiles)
        : mkdtemp(join(tmpdir(), "sandbox-factory-lockfiles-"))
    ).then(createLockfileStore));
  return {
    name: "local-process",
    async create({ label, signal }) {
      signal.throwIfAborted();
      let held: JobIdentity | null = null;
      if (isolation !== null) {
        held = free.shift() ?? quarantined.shift() ?? null;
        if (held === null)
          throw new Error("Every evaluation job identity is in use.");
      }
      const identity = held;
      const release = () => {
        if (identity !== null) free.push(identity);
      };
      const safe = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
      let directory: string;
      try {
        directory = await mkdtemp(
          join(options.root ?? tmpdir(), `sandbox-eval-${safe}-`),
        );
      } catch (error) {
        release();
        throw error;
      }
      const home = join(directory, "home");
      const work = join(directory, "work");
      // The job's temporary files, rather than the `/tmp` every job and
      // the worker share.
      const tmp = join(directory, "tmp");
      let npmCache: string;
      let unswept = false;
      try {
        await mkdir(home);
        await mkdir(work);
        await mkdir(tmp, { mode: 0o700 });
        if (isolation !== null && identity !== null) {
          // What an earlier job of this uid left running, if a worker
          // stopped before its teardown or its sweep failed, goes before
          // this one starts.
          try {
            await sweep(identity);
          } catch (error) {
            unswept = true;
            quarantine(identity, error);
            throw error;
          }
          // The job reaches its own directories by name and nothing else.
          await chmod(directory, 0o711);
          for (const own of [home, work, tmp]) {
            await chownTree(own, identity);
            await chmod(own, 0o700);
          }
          npmCache = await jobCache(isolation, identity);
        } else npmCache = await npmCacheOf();
      } catch (error) {
        // No job to destroy it later: the directory goes now.
        await rm(directory, { recursive: true, force: true });
        if (!unswept) release();
        throw error;
      }
      // No platform variables reach the processes: PATH to find node and
      // npm, a private HOME and temporary directory, the npm cache, and
      // nothing else. The cache is content-addressed and checked against
      // the lockfile's integrity on every install, so a package an earlier
      // job of this identity fetched is read from disk rather than from the
      // registry. The registry is set here, above any staged `.npmrc`.
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        CI: "1",
        npm_config_cache: npmCache,
        // npm logs into the cache otherwise, which outlives the job.
        npm_config_logs_dir: join(tmp, "npm-logs"),
        npm_config_registry: "https://registry.npmjs.org/",
        npm_config_prefer_offline: "true",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      };
      // Preparing a lockfile reads registry metadata into an empty cache of
      // its own, never the identity's, which earlier jobs (of any
      // organization) wrote and a revalidated entry would be read back
      // from: what it resolves is what the registry serves, so it may be
      // kept for other jobs. It fetches metadata only, so starting empty
      // costs little; installs keep the identity's cache, whose tarballs
      // are checked against the lockfile's sha512 integrity.
      const preparing = async (): Promise<Record<string, string>> => {
        const cache = await mkdtemp(join(directory, "prepare-cache-"));
        if (identity !== null) await chown(cache, identity.uid, identity.gid);
        await chmod(cache, 0o700);
        return {
          ...env,
          npm_config_cache: cache,
          npm_config_prefer_offline: "false",
          npm_config_prefer_online: "true",
        };
      };
      /** Every file staged so far, by its path in the job. */
      const staged = new Map<string, string>();
      /** Whether the lockfile in the job is the store's. */
      let fromStore = false;
      /** The manifest whose dependency set may use and feed the store. */
      let shared: string | null = null;
      /** The lockfile read before anything of the project's ran. */
      let prepared: string | null = null;
      let started = false;
      let ranProject = false;
      let destroyed = false;
      const job: EvaluationJob = {
        id: basename(directory),
        environment: {
          provider: "local-process",
          environmentId: `node@${process.versions.node}`,
          templateDigest: null,
        },
        async stage(files) {
          const targets = files.map((file) => inside(work, file.path));
          // Once processes ran they own the directory, and a link they left
          // would carry the worker's writes out of it.
          if (started) throw new Error("A job is staged before it runs.");
          for (const [index, file] of files.entries()) {
            const target = targets[index] ?? inside(work, file.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.text, "utf8");
            staged.set(relative(work, target), file.text);
          }
          // A dependency set resolved before starts from its lockfile, so
          // preparing it confirms the tree rather than resolving it again;
          // not for a project with its own lockfile, or with settings that
          // would resolve it differently. Decided on everything staged so
          // far, so a later call neither loses the project's lockfile to
          // the store's nor keeps the store's for another manifest.
          const manifest = staged.get("package.json");
          const npmrc = staged.get(".npmrc");
          const ownLockfile = staged.has("package-lock.json");
          const asked =
            manifest !== undefined &&
            !ownLockfile &&
            (npmrc === undefined || npmrcIsHarmless(npmrc))
              ? manifest
              : null;
          shared = asked;
          const lockfile = join(work, "package-lock.json");
          const kept =
            asked === null
              ? null
              : await storeOf()
                  .then((store) => store.get(asked))
                  .catch(() => null);
          if (ownLockfile) fromStore = false;
          else if (kept !== null) {
            await writeFile(lockfile, kept, "utf8");
            fromStore = true;
          } else if (fromStore) {
            await rm(lockfile, { force: true });
            fromStore = false;
          }
          if (identity !== null) await chownTree(work, identity);
        },
        async exec(command) {
          const cwd =
            command.cwd === undefined || command.cwd === ""
              ? work
              : inside(work, command.cwd);
          started = true;
          const preparation = isLockfilePreparation(command.argv);
          if (!preparation) ranProject = true;
          return runProcess(command, {
            cwd,
            env: preparation ? await preparing() : env,
            signal,
            identity,
          });
        },
        async read(path) {
          const text = await readInside(
            work,
            path,
            identity?.uid ?? process.getuid?.(),
          );
          if (path === "package-lock.json" && !ranProject && text !== null)
            prepared = text;
          return text;
        },
        async destroy() {
          // Once: a second call would hand the identity out twice.
          if (destroyed) return;
          destroyed = true;
          let unswept: { error: unknown } | null = null;
          try {
            if (identity !== null)
              try {
                await sweep(identity);
              } catch (error) {
                unswept = { error };
              }
            // Kept once the job is over, and only what npm prepared before
            // the project ran; the store checks it fits the manifest.
            const manifest = shared;
            const lockfile = prepared;
            if (manifest !== null && lockfile !== null)
              await storeOf()
                .then((store) => store.put(manifest, lockfile))
                .catch(() => false);
            await rm(directory, { recursive: true, force: true });
          } finally {
            // An identity whose processes may still run is not given to
            // the next job as clean.
            if (identity !== null && unswept !== null)
              quarantine(identity, unswept.error);
            else release();
          }
          if (unswept !== null) throw unswept.error;
        },
      };
      return job;
    },
  };
}
