/**
 * Golden slice outputs: what the slice adapter wrote for each scenario of
 * `slice.test.ts` and for the fixture slice before it moved onto carveout
 * 0.3.0's `analyse`, kept under `golden/slice/` as the oracle every run of
 * those scenarios is held to.
 *
 * Each run was recorded under both walks the adapter had then, in
 * `golden/slice/<scenario>/<n>-<walk>/` (artifacts, log, error):
 * graphify's graph walked by `reach` (`graph`, what the tests asserted)
 * and carveout 0.2.0's walk (`carveout`, what the worker ran). A run now
 * must write what the `carveout` recording holds, byte for byte, but for
 * `EXPECTED_DIFFERENCES`. Absolute scratch paths are replaced by
 * `<source>`, `<out>` and `<tmp>`, so a recording is the same on any
 * machine. `SLICE_GOLDEN_OUT=<dir>` records each run there too, in the
 * same layout, to diff by hand.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_GLOBAL_DECLARATIONS as CARVEOUT_GLOBALS } from "carveout/api";
import {
  NODE_GLOBAL_DECLARATIONS,
  SLICE_TOOL_VERSION,
  type BoundaryContract,
  type SliceManifest,
} from "sandbox-factory";
import { createSliceAdapter } from "../src/tools/slice.js";
import { CARVEOUT_WALK_ENGINE } from "../src/tools/slice/carveout-analysis.js";
import type { ArtifactFile, ToolRunInput } from "../src/tools/adapter.js";

export const GOLDEN_DIR = fileURLToPath(
  new URL("../../test/golden/slice/", import.meta.url),
);

type AdapterOptions = NonNullable<Parameters<typeof createSliceAdapter>[0]>;

let scenario = "unnamed";
let runs = 0;

/**
 * Tests renamed since their runs were recorded, by the name they were
 * recorded under: what they slice did not change, what they assert did.
 */
const RECORDED_AS: Readonly<Record<string, string>> = {
  "an entry point carveout's walk cannot read reaches nothing, and the slice fails saying so":
    "a language without an extractor still gets the manifest and names",
  "carveout analyses the slice, and the tool version names the release installed":
    "carveout's walk chooses the files from the source, and the slice tool builds the same boundary from them",
};

/** Names the scenario the next adapter runs belong to. */
export function goldenScenario(name: string): void {
  scenario = (RECORDED_AS[name] ?? name)
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
 * Runs the slice adapter as `createSliceAdapter(options).run(input)` does,
 * and holds what it wrote to the scenario's golden run of the same index
 * (`compareWithGolden`). Under `SLICE_GOLDEN_OUT=<dir>`, the run is also
 * recorded there, in the golden layout, for a diff by hand.
 */
export async function goldenRun(
  options: AdapterOptions,
  input: ToolRunInput,
): Promise<ArtifactFile[]> {
  const index = runs;
  runs += 1;
  const messages: string[] = [];
  const run: ToolRunInput = {
    ...input,
    log: (line) => {
      messages.push(line);
      input.log(line);
    },
  };
  let outcome: { files: ArtifactFile[] } | { error: unknown };
  try {
    outcome = { files: await createSliceAdapter(options).run(run) };
  } catch (error) {
    outcome = { error };
  }
  const inspect = process.env["SLICE_GOLDEN_OUT"];
  if (inspect !== undefined && inspect !== "")
    await record(
      join(inspect, scenario, String(index)),
      run,
      messages,
      outcome,
    );
  await compareWithGolden(
    join(GOLDEN_DIR, scenario, `${index}-carveout`),
    run,
    messages,
    outcome,
  );
  if ("error" in outcome) throw outcome.error;
  return outcome.files;
}

/**
 * The lines carveout's shim (`__slice__/packages.d.ts`) declares that the
 * platform's did not: `Buffer` as a generic, the asset modules a bundler
 * resolves (`*.css`, `*.svg`, …) and Vite's `import.meta.env` and `glob`.
 * carveout's `NODE_GLOBAL_DECLARATIONS` adds them; nothing else in the shim
 * changed.
 */
export const SHIM_ADDED_LINES = CARVEOUT_GLOBALS.filter(
  (line) => !NODE_GLOBAL_DECLARATIONS.includes(line),
);

/**
 * Where a run may differ from its golden one, each for a reason the move
 * onto carveout 0.3.0 gives; every other byte of every artifact and of the
 * log must match.
 */
export const EXPECTED_DIFFERENCES = {
  /** `slice@5` became `SLICE_TOOL_VERSION`, carveout's release in its suffix. */
  toolVersion: SLICE_TOOL_VERSION,
  /** `carveout@0.2.0` walked; now `analyse` of the pinned release does it all. */
  walkEngine: CARVEOUT_WALK_ENGINE,
  /** The shim grows by `SHIM_ADDED_LINES`, so its hash changes and the contract's with the version. */
  shimGrowthBytes: SHIM_ADDED_LINES.reduce(
    (total, line) => total + Buffer.byteLength(line) + 1,
    0,
  ),
} as const;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The golden manifest as the run must write it, by `EXPECTED_DIFFERENCES`. */
function expectedManifest(
  golden: SliceManifest,
  actual: SliceManifest,
): SliceManifest {
  return {
    ...golden,
    toolVersion: EXPECTED_DIFFERENCES.toolVersion,
    walkEngine: EXPECTED_DIFFERENCES.walkEngine,
    synthetic: golden.synthetic.map((file) =>
      file.kind === "shim"
        ? {
            ...file,
            generatorVersion: EXPECTED_DIFFERENCES.toolVersion,
            sizeBytes: file.sizeBytes + EXPECTED_DIFFERENCES.shimGrowthBytes,
            // The bytes are not recorded; the size and every other field are.
            sha256:
              actual.synthetic.find((own) => own.path === file.path)?.sha256 ??
              file.sha256,
          }
        : file,
    ),
    // Of the contract, which is compared whole.
    boundaryContractSha256: actual.boundaryContractSha256,
  };
}

/**
 * Holds one run to its golden recording: the same error, or the same
 * artifacts (the manifest and the contract field for field, everything
 * else byte for byte) and the same log, but for `EXPECTED_DIFFERENCES`.
 */
async function compareWithGolden(
  at: string,
  input: ToolRunInput,
  messages: readonly string[],
  outcome: { files: ArtifactFile[] } | { error: unknown },
): Promise<void> {
  const log = await readFile(join(at, "log.txt"), "utf8");
  assert.equal(
    `${messages.map((line) => normalized(line, input)).join("\n")}\n`,
    log,
    `${at}: log`,
  );
  const error = await readFile(join(at, "error.json"), "utf8").catch(
    () => null,
  );
  if (error !== null) {
    assert.ok("error" in outcome, `${at}: the golden run failed`);
    const { name, code } = JSON.parse(error) as { name: string; code: string };
    const thrown = outcome.error as { name?: string; code?: unknown };
    assert.deepEqual({ name: thrown.name, code: thrown.code }, { name, code });
    return;
  }
  assert.ok("files" in outcome, `${at}: the golden run succeeded`);
  const goldenFiles = await filesUnder(join(at, "artifacts"));
  assert.deepEqual(
    outcome.files.map((file) => file.path).sort(),
    goldenFiles,
    `${at}: artifacts`,
  );
  const text = async (path: string) =>
    normalized(
      await readFile(
        outcome.files.find((file) => file.path === path)?.absolutePath ?? "",
        "utf8",
      ),
      input,
    );
  const golden = (path: string) =>
    readFile(join(at, "artifacts", path), "utf8");
  for (const path of goldenFiles) {
    if (path === "slice-manifest.json") {
      const actual = JSON.parse(await text(path)) as SliceManifest;
      const recorded = JSON.parse(await golden(path)) as SliceManifest;
      // The fields the move must keep, named so a failure says which.
      for (const field of [
        "included",
        "cuts",
        "internalImports",
        "requiredBuildInputs",
        "externals",
        "blockers",
        "entryPoints",
      ] as const)
        assert.deepEqual(actual[field], recorded[field], `${at}: ${field}`);
      assert.deepEqual(actual, expectedManifest(recorded, actual), at);
    } else if (path === "boundary-contract.json") {
      const actual = JSON.parse(await text(path)) as BoundaryContract;
      const recorded = JSON.parse(await golden(path)) as BoundaryContract;
      assert.equal(actual.compilation.ok, recorded.compilation.ok, at);
      assert.deepEqual(
        actual,
        { ...recorded, toolVersion: EXPECTED_DIFFERENCES.toolVersion },
        at,
      );
    } else assert.equal(await text(path), await golden(path), `${at}: ${path}`);
  }
}
