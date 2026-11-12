/**
 * The hosted evaluation provider: one fresh E2B sandbox (a Firecracker
 * microVM) per job, created from a template with Node 22 or later and
 * killed on every path.
 *
 * The worker talks to E2B's API with its key; nothing of the worker reaches
 * the sandbox. Files go in through the filesystem API, and every command
 * runs as the template's unprivileged `user` with a fixed environment (the
 * sandbox's own PATH, a HOME, the public registry, and the command's fixture
 * values), never the worker's variables or the key. The sandbox can reach
 * only the public registry (`registry.npmjs.org`, and the DNS server E2B
 * opens beside a domain rule) while the trusted lockfile preparation and the
 * clean install run; before any other command its egress is cut to nothing
 * (`updateNetwork`), and a failed cut fails the job rather than run the
 * project with a network. Whether the cut happened is the job's
 * `egressCut`, kept on the execution record.
 *
 * Commands are the caller's argv, quoted for the sandbox's shell. Each is
 * bounded by its own timeout, the job's budget (`budgetMs`, also the
 * sandbox's own lifetime at E2B, so a worker that dies leaves nothing
 * running for long) and an output cap; after each, every process the job's
 * user still runs is killed, so a server a command started does not outlive
 * it. A hidden test (`privateTestArgv`'s shape) runs in a fresh copy of the
 * job's files as they stood before the first one ran, removed and copied
 * again for the next, so no run leaves state for another.
 *
 * The SDK sits behind `E2BClient` (`e2bClient` adapts it), so tests drive a
 * fake and never call E2B.
 */

import { posix } from "node:path";
import {
  CommandExitError,
  FileNotFoundError,
  Sandbox,
  TimeoutError,
} from "e2b";
import type { SandboxOpts } from "e2b";
import { EVALUATION_LIMITS, privateTestArgv } from "sandbox-factory";
import type {
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationJob,
  EvaluationProvider,
} from "sandbox-factory";
import { isLockfilePreparation } from "./lockfiles.js";

/** The only host a job reaches, and only until the install has run. */
export const E2B_REGISTRY_HOST = "registry.npmjs.org";
/** E2B's every-destination rule. */
const ALL_TRAFFIC = "0.0.0.0/0";
/** The unprivileged user E2B templates run commands as, and its home. */
const JOB_USER = "user";
const HOME = "/home/user";
const JOB_ROOT = `${HOME}/job`;
const WORK = `${JOB_ROOT}/work`;
/** The job's files before the first hidden test, and a test's copy of them. */
const PRISTINE = `${JOB_ROOT}/pristine`;
const FRESH = `${JOB_ROOT}/fresh`;
/** The SDK's own template when none is configured. */
export const E2B_DEFAULT_TEMPLATE = "base";
/** The job budget when none is configured: a baseline is well within it. */
export const E2B_JOB_BUDGET_MS = 20 * 60 * 1000;
/** How long E2B keeps a sandbox past the budget before killing it itself. */
const LIFETIME_GRACE_MS = 60 * 1000;
/** How long the job's own housekeeping commands may take. */
const HOUSEKEEPING_MS = 60 * 1000;
/** Past this, a file a job left is not read back. */
const READ_MAX_BYTES = 32 * 1024 * 1024;
/** `SANDBOX_TOOLCHAIN.nodeRange`: what the template's `node` must satisfy. */
const NODE_MIN = [22, 12] as const;

export interface E2BRunOptions {
  readonly cwd: string;
  readonly envs: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onStdout: (data: string) => void;
  readonly onStderr: (data: string) => void;
}

export interface E2BRunResult {
  /** Null when the process ended by a signal or did not end in time. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** The part of an E2B sandbox a job uses. */
export interface E2BSandbox {
  readonly sandboxId: string;
  write(
    files: readonly { readonly path: string; readonly text: string }[],
  ): Promise<void>;
  /** A regular file's text, or null when absent, not a file or too large. */
  readText(path: string, maxBytes: number): Promise<string | null>;
  run(command: string, options: E2BRunOptions): Promise<E2BRunResult>;
  /** Replaces every egress rule; an empty `allowOut` allows nothing. */
  denyEgress(): Promise<void>;
  kill(): Promise<void>;
}

export interface E2BCreateOptions {
  readonly template: string;
  /** The sandbox's lifetime at E2B, after which E2B kills it. */
  readonly timeoutMs: number;
  readonly metadata: Readonly<Record<string, string>>;
  /** Hosts the sandbox may reach; everything else is denied. */
  readonly allowOut: readonly string[];
  readonly signal: AbortSignal;
}

export interface E2BClient {
  create(options: E2BCreateOptions): Promise<E2BSandbox>;
}

/** `Sandbox.create` from the SDK, or a stand-in with its shape. */
export interface E2BSdk {
  create(template: string, options: SandboxOpts): Promise<Sandbox>;
}

const SDK: E2BSdk = {
  create: (template, options) => Sandbox.create(template, options),
};

/** The SDK behind `E2BClient`, authenticated with the worker's key. */
export function e2bClient(apiKey: string, sdk: E2BSdk = SDK): E2BClient {
  return {
    async create(options) {
      const sandbox = await sdk.create(options.template, {
        apiKey,
        timeoutMs: options.timeoutMs,
        metadata: { ...options.metadata },
        // A domain is allowed only beside a deny-all rule.
        network: { allowOut: [...options.allowOut], denyOut: [ALL_TRAFFIC] },
        signal: options.signal,
      });
      return {
        sandboxId: sandbox.sandboxId,
        async write(files) {
          await sandbox.files.write(
            files.map((file) => ({ path: file.path, data: file.text })),
            { user: JOB_USER },
          );
        },
        async readText(path, maxBytes) {
          try {
            const info = await sandbox.files.getInfo(path, { user: JOB_USER });
            // Not followed: a link the job left could point anywhere.
            if (info.type !== "file" || info.size > maxBytes) return null;
            return await sandbox.files.read(path, {
              user: JOB_USER,
              format: "text",
            });
          } catch (error) {
            if (error instanceof FileNotFoundError) return null;
            throw error;
          }
        },
        async run(command, run) {
          try {
            const result = await sandbox.commands.run(command, {
              cwd: run.cwd,
              envs: { ...run.envs },
              user: JOB_USER,
              timeoutMs: run.timeoutMs,
              signal: run.signal,
              retainOutput: false,
              onStdout: run.onStdout,
              onStderr: run.onStderr,
            });
            return { exitCode: result.exitCode, timedOut: false };
          } catch (error) {
            if (run.signal.aborted) throw run.signal.reason;
            if (error instanceof CommandExitError)
              return {
                exitCode: error.exitCode < 0 ? null : error.exitCode,
                timedOut: false,
              };
            if (error instanceof TimeoutError)
              return { exitCode: null, timedOut: true };
            throw error;
          }
        },
        async denyEgress() {
          // Replaces the creation rules: no allowed host is left.
          await sandbox.updateNetwork({ denyOut: [ALL_TRAFFIC] });
        },
        async kill() {
          // False when E2B already removed it, at its lifetime or otherwise.
          await sandbox.kill();
        },
      };
    },
  };
}

export interface E2BProviderOptions {
  readonly client: E2BClient;
  /** Template name or id; the SDK's `base` when absent. Needs Node 22.12+. */
  readonly template?: string;
  /** The whole job's wall-clock budget, every command included. */
  readonly budgetMs?: number;
  readonly now?: () => number;
}

/** A word for the sandbox's shell, exactly as given. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The argv as one command line, run in place of the shell. */
export function commandLine(argv: readonly string[]): string {
  return `exec ${argv.map(shellQuote).join(" ")}`;
}

/** A path inside `root`; anything that leaves it is refused. */
function inside(root: string, path: string): string {
  if (path.includes("\0") || posix.isAbsolute(path))
    throw new Error(`Path ${path} leaves the job directory.`);
  const absolute = posix.join(root, path);
  const rel = posix.relative(root, absolute);
  if (rel === "" || rel.startsWith(".."))
    throw new Error(`Path ${path} leaves the job directory.`);
  return absolute;
}

/** The clean install, with no package's scripts. */
const isInstall = (argv: readonly string[]) =>
  argv[0] === "npm" && argv[1] === "ci" && argv.includes("--ignore-scripts");

const HIDDEN_TEST_PREFIX = privateTestArgv("x").slice(0, -1);
/** One hidden test's run, as `privateTestArgv` writes it. */
export function isHiddenTestRun(argv: readonly string[]): boolean {
  return (
    argv.length === HIDDEN_TEST_PREFIX.length + 1 &&
    HIDDEN_TEST_PREFIX.every((word, index) => argv[index] === word)
  );
}

/** Whether `node --version`'s answer meets the toolchain's range. */
export function meetsNodeRange(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]);
}

/**
 * Every variable a job's command sees, besides the sandbox's own login
 * environment: none of the worker's. The registry is set here, above any
 * staged `.npmrc`.
 */
const JOB_ENV: Readonly<Record<string, string>> = {
  HOME,
  LANG: "C.UTF-8",
  NO_COLOR: "1",
  CI: "1",
  npm_config_registry: `https://${E2B_REGISTRY_HOST}/`,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};

/** Every process the job's user runs, but the shell that asks. */
const KILL_JOB_PROCESSES = "kill -KILL -1 2>/dev/null; exit 0";

class BudgetExceeded extends Error {
  constructor() {
    super("The E2B evaluation job ran past its budget.");
  }
}

export function createE2BProvider(
  options: E2BProviderOptions,
): EvaluationProvider {
  const template = options.template ?? E2B_DEFAULT_TEMPLATE;
  const budgetMs = options.budgetMs ?? E2B_JOB_BUDGET_MS;
  const now = options.now ?? Date.now;
  return {
    name: "e2b",
    async create({ label, signal }) {
      signal.throwIfAborted();
      const deadline = now() + budgetMs;
      const sandbox = await options.client.create({
        template,
        timeoutMs: budgetMs + LIFETIME_GRACE_MS,
        metadata: { label: label.slice(0, 120) },
        allowOut: [E2B_REGISTRY_HOST],
        signal,
      });
      let started = false;
      let cut = false;
      let pristine = false;
      let destroyed = false;
      const remaining = () => deadline - now();
      /**
       * One command line with its output capped and, for the caller's
       * commands (`sweep`), whatever it left running killed.
       */
      const execute = async (
        line: string,
        cwd: string,
        env: Readonly<Record<string, string>>,
        limits: { timeoutMs: number; maxOutputBytes: number },
        sweep: boolean,
      ): Promise<EvaluationExecResult> => {
        signal.throwIfAborted();
        const left = remaining();
        if (left <= 0) throw new BudgetExceeded();
        const timeoutMs = Math.min(limits.timeoutMs, left);
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let truncated = false;
        const collect = (data: string, isStdout: boolean) => {
          const chunk = Buffer.from(data, "utf8");
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
        const begun = now();
        const result = await sandbox.run(line, {
          cwd,
          envs: env,
          timeoutMs,
          signal,
          onStdout: (data) => collect(data, true),
          onStderr: (data) => collect(data, false),
        });
        const durationMs = now() - begun;
        // What the command left running goes with it, timed out or not.
        if (sweep)
          await sandbox.run(KILL_JOB_PROCESSES, {
            cwd: HOME,
            envs: JOB_ENV,
            timeoutMs: HOUSEKEEPING_MS,
            signal,
            onStdout: () => undefined,
            onStderr: () => undefined,
          });
        // Cut short by the budget rather than its own timeout: the job, not
        // the step, failed.
        if (result.timedOut && timeoutMs < limits.timeoutMs)
          throw new BudgetExceeded();
        return {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputTruncated: truncated,
          stdout,
          stderr,
          durationMs,
        };
      };
      /** A housekeeping command that must succeed. */
      const housekeep = async (line: string) => {
        const result = await execute(
          line,
          HOME,
          JOB_ENV,
          { timeoutMs: HOUSEKEEPING_MS, maxOutputBytes: 4 * 1024 },
          false,
        );
        if (result.exitCode !== 0)
          throw new Error(
            `E2B job housekeeping failed: ${result.stderr.trim()}`,
          );
        return result.stdout;
      };
      let environmentId: string;
      try {
        await housekeep(`mkdir -p ${shellQuote(WORK)}`);
        const version = (await housekeep("node --version")).trim();
        if (!meetsNodeRange(version))
          throw new Error(
            `E2B template ${template} has node ${version || "missing"}; the toolchain needs >=${NODE_MIN.join(".")}.`,
          );
        environmentId = `${template}/node@${version.replace(/^v/, "")}`;
      } catch (error) {
        await sandbox.kill().catch(() => undefined);
        throw error;
      }
      const job: EvaluationJob = {
        id: sandbox.sandboxId,
        environment: { provider: "e2b", environmentId, templateDigest: null },
        async stage(files) {
          if (started) throw new Error("A job is staged before it runs.");
          const targets = files.map((file) => ({
            path: inside(WORK, file.path),
            text: file.text,
          }));
          await sandbox.write(targets);
        },
        async exec(command: EvaluationCommand) {
          if (destroyed) throw new Error("The job was destroyed.");
          if (command.argv[0] === undefined)
            throw new Error("A command needs an executable.");
          const limits = command.limits ?? EVALUATION_LIMITS;
          started = true;
          // Nothing but the trusted preparation and install runs while the
          // registry is reachable.
          if (
            !cut &&
            !isLockfilePreparation(command.argv) &&
            !isInstall(command.argv)
          ) {
            await sandbox.denyEgress();
            cut = true;
          }
          let root = WORK;
          if (isHiddenTestRun(command.argv)) {
            if (!pristine) {
              await housekeep(
                `cp -a ${shellQuote(WORK)} ${shellQuote(PRISTINE)}`,
              );
              pristine = true;
            }
            await housekeep(
              `rm -rf ${shellQuote(FRESH)} && cp -a ${shellQuote(PRISTINE)} ${shellQuote(FRESH)}`,
            );
            root = FRESH;
          }
          const cwd =
            command.cwd === undefined || command.cwd === ""
              ? root
              : inside(root, command.cwd);
          return execute(
            commandLine(command.argv),
            cwd,
            { ...JOB_ENV, ...(command.env ?? {}) },
            limits,
            true,
          );
        },
        async read(path) {
          return sandbox.readText(inside(WORK, path), READ_MAX_BYTES);
        },
        async destroy() {
          // Once: the sandbox is gone after the first.
          if (destroyed) return;
          destroyed = true;
          await sandbox.kill();
        },
        egressCut: () => cut,
      };
      return job;
    },
  };
}
