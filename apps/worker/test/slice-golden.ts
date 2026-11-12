/**
 * Golden slice outputs: what the slice adapter wrote for each scenario of
 * `slice.test.ts` and for the fixture slice, kept under `golden/slice/` as
 * the oracle a change to the slice tool is diffed against.
 *
 * `SLICE_GOLDEN=write` records them: every adapter run of a scenario runs
 * under both walks the adapter had then, graphify's graph (`graph`, what
 * the tests asserted) and carveout's (`carveout`, what the worker ran), and
 * each run's artifacts, log and error land in
 * `golden/slice/<scenario>/<n>-<walk>/`. Absolute scratch paths are
 * replaced by `<source>`, `<out>` and `<tmp>`, so a recording is the same
 * on any machine. Unset, nothing is recorded.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSliceAdapter } from "../src/tools/slice.js";
import type { ArtifactFile, ToolRunInput } from "../src/tools/adapter.js";

export const GOLDEN_DIR = fileURLToPath(
  new URL("../../test/golden/slice/", import.meta.url),
);

type AdapterOptions = NonNullable<Parameters<typeof createSliceAdapter>[0]>;
type Walk = "graph" | "carveout";

let scenario = "unnamed";
let runs = 0;

/** Names the scenario the next adapter runs belong to. */
export function goldenScenario(name: string): void {
  scenario = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  runs = 0;
}

/** A recording's text with the run's scratch paths named, not spelled. */
export function normalized(text: string, input: ToolRunInput): string {
  const tmp = tmpdir();
  return text
    .split(input.sourceDir.replace(/\/$/, ""))
    .join("<source>")
    .split(input.outDir.replace(/\/$/, ""))
    .join("<out>")
    .split(tmp.replace(/\/$/, ""))
    .join("<tmp>");
}

async function record(
  at: string,
  input: ToolRunInput,
  messages: readonly string[],
  outcome: { files: ArtifactFile[] } | { error: unknown },
): Promise<void> {
  await rm(at, { recursive: true, force: true });
  await mkdir(at, { recursive: true });
  const lines = messages.map((line) => normalized(line, input));
  await writeFile(join(at, "log.txt"), `${lines.join("\n")}\n`);
  if ("error" in outcome) {
    const error = outcome.error as {
      name?: string;
      code?: unknown;
      message?: string;
    };
    await writeFile(
      join(at, "error.json"),
      `${JSON.stringify(
        {
          name: error.name ?? null,
          code: error.code ?? null,
          message: normalized(error.message ?? "", input),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  for (const file of outcome.files) {
    const text = await readFile(file.absolutePath, "utf8");
    const target = join(at, "artifacts", file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, normalized(text, input));
  }
}

/**
 * Runs the slice adapter as `createSliceAdapter(options).run(input)` does;
 * under `SLICE_GOLDEN=write`, also records the run under both walks.
 */
export async function goldenRun(
  options: AdapterOptions,
  input: ToolRunInput,
): Promise<ArtifactFile[]> {
  if (process.env["SLICE_GOLDEN"] !== "write")
    return createSliceAdapter(options).run(input);
  const index = runs;
  runs += 1;
  const asked: Walk = options.walker ?? "graph";
  let result: { files: ArtifactFile[] } | { error: unknown } | undefined;
  for (const walk of [
    asked,
    asked === "graph" ? "carveout" : "graph",
  ] as const) {
    const out =
      walk === asked
        ? input.outDir
        : await mkdtemp(join(tmpdir(), "slice-golden-"));
    const messages: string[] = [];
    const run: ToolRunInput = {
      ...input,
      outDir: out,
      log: (line) => {
        messages.push(line);
        if (walk === asked) input.log(line);
      },
    };
    let outcome: { files: ArtifactFile[] } | { error: unknown };
    try {
      outcome = {
        files: await createSliceAdapter({ ...options, walker: walk }).run(run),
      };
    } catch (error) {
      outcome = { error };
    }
    await record(
      join(GOLDEN_DIR, scenario, `${index}-${walk}`),
      run,
      messages,
      outcome,
    );
    if (walk === asked) result = outcome;
    else await rm(out, { recursive: true, force: true });
  }
  if (result === undefined || "error" in result)
    throw (result as { error: unknown }).error;
  return result.files;
}
