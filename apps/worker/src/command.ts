import { spawn } from "node:child_process";
import { CommandError } from "./errors.js";

/** Platform credentials never enter parser subprocesses. Abort their whole group. */
export function command(
  executable: string,
  args: readonly string[],
  options: { signal: AbortSignal; cwd?: string },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"],
        LANG: "C.UTF-8",
        PYTHONHASHSEED: "0",
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let output = "";
    let bytes = 0;
    let exceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        exceeded = true;
        abort();
        return;
      }
      if (stdout) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (options.signal.aborted) reject(options.signal.reason);
      else if (code !== 0 || exceeded) reject(new CommandError(code));
      else resolve(output);
    });
  });
}
