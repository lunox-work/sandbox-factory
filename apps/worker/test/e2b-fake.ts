import type {
  E2BClient,
  E2BCreateOptions,
  E2BRunOptions,
  E2BSandbox,
} from "../src/evaluation/e2b.js";

/** What a scripted command does; every field defaults to a quick exit 0. */
export interface FakeOutcome {
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  /** How far the fake clock moves while it runs; 1 ms by default. */
  readonly advanceMs?: number;
}

export interface FakeRun {
  readonly command: string;
  readonly cwd: string;
  readonly envs: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * An E2B stand-in that records what a job sends and answers commands from a
 * script, on a clock of its own: nothing reaches E2B. Housekeeping (the
 * directory, the Node probe, copies and the sweep) succeeds unless asked.
 */
export function fakeE2B(
  script: (command: string) => FakeOutcome | Error | undefined = () =>
    undefined,
  options: {
    readonly node?: string;
    readonly createFails?: boolean;
    readonly denyFails?: boolean;
    readonly killFails?: boolean;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) {
  let clock = 0;
  const created: E2BCreateOptions[] = [];
  const writes: { path: string; text: string }[] = [];
  const runs: FakeRun[] = [];
  /** Each event in order: runs by command, `deny`, `kill`. */
  const events: string[] = [];
  let killed = 0;
  let denied = 0;
  const files = new Map(Object.entries(options.files ?? {}));
  const client: E2BClient = {
    async create(spec) {
      created.push(spec);
      if (options.createFails === true) throw new Error("E2B down");
      const sandbox: E2BSandbox = {
        sandboxId: `sbx_${created.length}`,
        async write(entries) {
          for (const entry of entries) {
            writes.push({ path: entry.path, text: entry.text });
            files.set(entry.path, entry.text);
          }
        },
        async readText(path, maxBytes) {
          const text = files.get(path);
          return text === undefined || Buffer.byteLength(text) > maxBytes
            ? null
            : text;
        },
        async run(command: string, run: E2BRunOptions) {
          runs.push({
            command,
            cwd: run.cwd,
            envs: { ...run.envs },
            timeoutMs: run.timeoutMs,
          });
          events.push(command);
          run.signal.throwIfAborted();
          const outcome: FakeOutcome | Error | undefined =
            command === "node --version"
              ? { stdout: `${options.node ?? "v22.12.0"}\n` }
              : /^(mkdir|cp|rm|kill) /.test(command)
                ? {}
                : script(command);
          if (outcome instanceof Error) throw outcome;
          clock += outcome?.advanceMs ?? 1;
          if (outcome?.stdout !== undefined) run.onStdout(outcome.stdout);
          if (outcome?.stderr !== undefined) run.onStderr(outcome.stderr);
          return {
            exitCode:
              outcome?.exitCode === undefined
                ? outcome?.timedOut === true
                  ? null
                  : 0
                : outcome.exitCode,
            timedOut: outcome?.timedOut ?? false,
          };
        },
        async denyEgress() {
          events.push("deny");
          if (options.denyFails === true) throw new Error("network update");
          denied += 1;
        },
        async kill() {
          events.push("kill");
          killed += 1;
          if (options.killFails === true) throw new Error("kill failed");
        },
      };
      return sandbox;
    },
  };
  return {
    client,
    now: () => clock,
    created,
    writes,
    runs,
    events,
    killed: () => killed,
    denied: () => denied,
  };
}
