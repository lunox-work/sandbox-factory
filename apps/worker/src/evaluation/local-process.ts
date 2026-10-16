/**
 * The development evaluation provider: a fresh temporary directory and
 * child processes with a scrubbed environment.
 *
 * It satisfies the adapter contract (fresh job, staged inputs, bounded
 * execution, teardown) so the build and the fixture round trip work
 * without a hosted account, and it is what compose runs. It is **not** an
 * isolation boundary: the processes share the worker's kernel, network and
 * filesystem permissions. Hosted evaluation of contributor code needs a
 * provider that meets Decision 5 of the sandbox plan; this one records
 * itself as `local-process` so no record can mistake it for one.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

export interface LocalProcessOptions {
  /** Where job directories are created; the OS temp directory by default. */
  readonly root?: string;
  /**
   * The npm cache every job shares, outside any job's directory, and the
   * lockfiles resolved for each distinct `package.json` beside it. A
   * directory of this provider's own under the OS temp directory by
   * default, made once and not at a name another user could guess.
   */
  readonly npmCache?: string;
}

/**
 * Where the lockfile resolved for a dependency set is kept: keyed by what
 * `package.json` asks to install, not by its name or version, which differ
 * between the versions of one sandbox. Null for one that does not parse.
 */
function lockfilePath(cache: string, packageJson: string): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(packageJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const asked = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
  ].map((field) => [field, manifest[field] ?? null]);
  const digest = createHash("sha256")
    .update(JSON.stringify(asked))
    .digest("hex");
  return join(cache, "_lockfiles", `${digest}.json`);
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
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
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

export function createLocalProcessProvider(
  options: LocalProcessOptions = {},
): EvaluationProvider {
  let sharedCache: Promise<string> | undefined;
  const npmCacheOf = () =>
    options.npmCache !== undefined
      ? Promise.resolve(options.npmCache)
      : (sharedCache ??= mkdtemp(join(tmpdir(), "sandbox-factory-npm-cache-")));
  return {
    name: "local-process",
    async create({ label, signal }) {
      signal.throwIfAborted();
      const safe = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
      const directory = await mkdtemp(
        join(options.root ?? tmpdir(), `sandbox-eval-${safe}-`),
      );
      const home = join(directory, "home");
      const work = join(directory, "work");
      let npmCache: string;
      try {
        await mkdir(home);
        await mkdir(work);
        npmCache = await npmCacheOf();
      } catch (error) {
        // No job to destroy it later: the directory goes now.
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      // No platform variables reach the processes: PATH to find node and
      // npm, a private HOME, the shared npm cache, and nothing else. The
      // cache is content-addressed and checked against the lockfile's
      // integrity on every install, so a package one job fetched is read
      // from disk by the next rather than from the registry.
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        CI: "1",
        npm_config_cache: npmCache,
        npm_config_prefer_offline: "true",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      };
      /** Where this job's dependency set keeps its lockfile, once staged. */
      let lockfile: string | null = null;
      const job: EvaluationJob = {
        id: basename(directory),
        environment: {
          provider: "local-process",
          environmentId: `node@${process.versions.node}`,
          templateDigest: null,
        },
        async stage(files) {
          for (const file of files) {
            const absolute = inside(work, file.path);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, file.text, "utf8");
          }
          // A dependency set resolved before starts from its lockfile, so
          // preparing it confirms the tree rather than resolving it again.
          const manifest = files.find((file) => file.path === "package.json");
          if (
            manifest !== undefined &&
            !files.some((file) => file.path === "package-lock.json")
          ) {
            lockfile = lockfilePath(npmCache, manifest.text);
            const kept =
              lockfile === null
                ? null
                : await readFile(lockfile, "utf8").catch(() => null);
            if (kept !== null)
              await writeFile(join(work, "package-lock.json"), kept, "utf8");
          }
        },
        async exec(command) {
          const cwd =
            command.cwd === undefined || command.cwd === ""
              ? work
              : inside(work, command.cwd);
          return runProcess(command, { cwd, env, signal });
        },
        async read(path) {
          const text = await readFile(inside(work, path), "utf8").catch(
            () => null,
          );
          // A lockfile is read once it is prepared: it is kept for the
          // next job with the same dependencies.
          if (
            path === "package-lock.json" &&
            text !== null &&
            lockfile !== null
          )
            await keepLockfile(lockfile, text).catch(() => {});
          return text;
        },
        async destroy() {
          await rm(directory, { recursive: true, force: true });
        },
      };
      return job;
    },
  };
}

/** Writes whole or not at all, so a job never reads half a lockfile. */
async function keepLockfile(path: string, lockfile: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}`;
  await writeFile(partial, lockfile, "utf8");
  await rename(partial, path);
}
