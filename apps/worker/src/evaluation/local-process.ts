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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || isAbsolute(path))
    throw new Error(`Path ${path} leaves the job directory.`);
  return absolute;
}

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
    const abort = () => stop();
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted) reject(options.signal.reason);
      else
        resolvePromise({
          exitCode: code,
          timedOut,
          outputTruncated: truncated,
          stdout,
          stderr,
          durationMs: Date.now() - started,
        });
    });
  });
}

export function createLocalProcessProvider(
  options: LocalProcessOptions = {},
): EvaluationProvider {
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
      await mkdir(home);
      await mkdir(work);
      // No platform variables reach the processes: PATH to find node and
      // npm, a private HOME and npm cache, and nothing else.
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        CI: "1",
        npm_config_cache: join(home, ".npm"),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      };
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
        },
        async exec(command) {
          const cwd =
            command.cwd === undefined || command.cwd === ""
              ? work
              : inside(work, command.cwd);
          return runProcess(command, { cwd, env, signal });
        },
        async read(path) {
          return readFile(inside(work, path), "utf8").catch(() => null);
        },
        async destroy() {
          await rm(directory, { recursive: true, force: true });
        },
      };
      return job;
    },
  };
}
