/**
 * The import adapter: a hand-off folder carveout cut and pseudonymised on
 * the maintainer's machine, uploaded with the maintainer's acceptance tests
 * (`POST /sandboxes/uploads`), made the draft version it names.
 *
 * The folder's files are its public project, verbatim, under `project/`;
 * the acceptance tests are its hidden tests, under `private/` at the paths
 * they have in the folder. Nothing is generated, renamed or aliased: the
 * platform never had the folder's private names, and its table stays in
 * the maintainer's receipt. The layout comes from the folder's own record
 * (`folderLayout`), mapped into core's `GradingLayout` and recorded in the
 * build manifest, which grading reads. The descriptor the platform adds,
 * `sandbox-task.json`, names the editable paths: the record's included
 * files that are not tests.
 *
 * The baseline then runs the layout's commands (`runLayoutBaseline`), and
 * every acceptance test must fail on it: a test that passes before the
 * work accepts anything. The run calls no model.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { folderLayout, type FolderLayout } from "carveout/api";
import {
  SANDBOX_COMMANDS,
  SANDBOX_IMPORT_TOOL_VERSION,
  SANDBOX_TOOLCHAIN,
  TASK_DESCRIPTOR_PATH,
  TASK_DESCRIPTOR_SCHEMA_VERSION,
  isSandboxImportParams,
} from "sandbox-factory";
import type {
  AcceptanceTest,
  EvaluationProvider,
  GeneratedFile,
  GradingLayout,
  PathClass,
  ProjectBlocker,
  SandboxBuildManifest,
  TaskDescriptor,
} from "sandbox-factory";
import type { ToolAdapter, ToolRunInput } from "./adapter.js";
import { AnalysisError } from "../errors.js";
import {
  baselineOf,
  descriptorTestSummary,
  writeBuildOutputs,
} from "./sandbox-build.js";

/** The record path a carveout folder keeps at its root. */
export const RECORD_PATH = "carveout.json";
/** Test files by name, as carveout's runner finds them. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** What an upload stores: the folder's files and the acceptance tests, as the route wrote them. */
export interface StoredUpload {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly acceptanceTests: readonly AcceptanceTest[];
}

/** The stored text read back; null when it is not an upload. */
export function parseUpload(text: string): StoredUpload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const isFile = (item: unknown): item is { path: string; text: string } =>
    item !== null &&
    typeof item === "object" &&
    typeof (item as { path?: unknown }).path === "string" &&
    typeof (item as { text?: unknown }).text === "string";
  const record = value as { files?: unknown; acceptanceTests?: unknown };
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.acceptanceTests) ||
    !record.files.every(isFile) ||
    !record.acceptanceTests.every(
      (test) =>
        isFile(test) &&
        ((test as { expectedBaseline?: unknown }).expectedBaseline === "fail" ||
          (test as { expectedBaseline?: unknown }).expectedBaseline === "pass"),
    )
  )
    return null;
  return {
    files: record.files.map(({ path, text: body }) => ({ path, text: body })),
    acceptanceTests: (record.acceptanceTests as AcceptanceTest[]).map(
      ({ path, text: body, expectedBaseline }) => ({
        path,
        text: body,
        expectedBaseline,
      }),
    ),
  };
}

/**
 * carveout's layout of a folder as grading reads it: the same, with the
 * descriptor the platform adds among the files a submission never changes.
 */
export function gradingLayoutOf(folder: FolderLayout): GradingLayout {
  return {
    harnessDir: folder.harnessDir,
    mocksDir: folder.mocksDir,
    mockRuntimePath: folder.mockRuntimePath,
    envFile: folder.envFile,
    harnessRoots: [...folder.harnessRoots],
    configFiles: {
      ...folder.configFiles,
      [TASK_DESCRIPTOR_PATH]: `${TASK_DESCRIPTOR_PATH} is the version's.`,
    },
    commands: folder.commands.map(({ name, argv }) => ({
      name,
      argv: [...argv],
    })),
    tests: {
      publicDir: folder.tests.publicDir,
      privateDir: folder.tests.privateDir,
      files: [...folder.tests.files],
      run: {
        "node:test": {
          argv: [...folder.tests.run["node:test"].argv],
          emitted: folder.tests.run["node:test"].emitted,
        },
        vitest:
          folder.tests.run.vitest === null
            ? null
            : {
                argv: [...folder.tests.run.vitest.argv],
                emitted: folder.tests.run.vitest.emitted,
              },
      },
    },
  };
}

const under = (path: string, dir: string) =>
  path === dir || path.startsWith(`${dir}/`);

/** A folder file's class in the build manifest. */
export function classOf(
  path: string,
  layout: GradingLayout,
  generated: ReadonlySet<string>,
): PathClass {
  if (path === TASK_DESCRIPTOR_PATH) return "descriptor";
  if (layout.configFiles[path] !== undefined || path === "package-lock.json")
    return "config";
  if (layout.tests.files.includes(path)) return "test-public";
  if (under(path, layout.mocksDir)) return "mock";
  if (under(path, layout.harnessDir)) return "harness";
  if (generated.has(path)) return "stub";
  return TEST_FILE.test(path) ? "test-public" : "source";
}

interface FolderRecord {
  readonly lockfile?: unknown;
  readonly publicScrubbed?: unknown;
  readonly request?: { readonly public?: unknown };
  readonly generated?: readonly { readonly path?: unknown }[];
  readonly manifest?: {
    readonly included?: readonly { readonly path?: unknown }[];
  };
}

const pathsOf = (list: readonly { readonly path?: unknown }[] | undefined) =>
  (list ?? []).flatMap((item) =>
    typeof item.path === "string" ? [item.path] : [],
  );

export function createSandboxImportAdapter(options: {
  readonly provider: EvaluationProvider | null;
  readonly now?: () => Date;
}): ToolAdapter {
  const now = options.now ?? (() => new Date());
  return {
    name: "sandbox_import",
    version: SANDBOX_IMPORT_TOOL_VERSION,
    async run(input: ToolRunInput) {
      const params = input.params;
      if (!isSandboxImportParams(params))
        throw new AnalysisError("tool_failed");
      if (options.provider === null) {
        input.log("No evaluation provider is configured on this worker.");
        throw new AnalysisError("evaluation_failed");
      }
      const stored = await input.inputs.getVersion(params.sandboxVersionId);
      // The draft still names this run as the one that writes it.
      if (
        stored === null ||
        (input.runId !== undefined &&
          stored.source.starterRunId !== input.runId)
      )
        throw new AnalysisError("tool_failed");
      const text = await input.inputs.readUpload?.(
        params.sandboxVersionId,
        params.uploadSha256,
      );
      // The object is the one the run was queued for, byte for byte.
      if (
        text === null ||
        text === undefined ||
        sha256(text) !== params.uploadSha256
      )
        throw new AnalysisError("tool_failed");
      const upload = parseUpload(text);
      const recordFile = upload?.files.find(
        (file) => file.path === RECORD_PATH,
      );
      if (
        upload === null ||
        recordFile === undefined ||
        sha256(recordFile.text) !== params.recordSha256
      )
        throw new AnalysisError("tool_failed");
      const record = JSON.parse(recordFile.text) as FolderRecord;
      const layout = gradingLayoutOf(
        folderLayout(record as Parameters<typeof folderLayout>[0]),
      );
      const blockers: ProjectBlocker[] = [];
      if (record.lockfile !== true)
        blockers.push({
          code: "baseline_failed",
          file: RECORD_PATH,
          detail:
            "The folder was cut without its lockfile; the platform installs only from one.",
        });
      const generated = new Set(pathsOf(record.generated));
      const held = new Set(upload.files.map((file) => file.path));
      const editablePaths = pathsOf(record.manifest?.included)
        .filter(
          (path) =>
            held.has(path) &&
            !TEST_FILE.test(path) &&
            !layout.tests.files.includes(path),
        )
        .sort();
      const publicTests = layout.tests.files.filter((path) => held.has(path));
      const descriptor: TaskDescriptor = {
        schemaVersion: TASK_DESCRIPTOR_SCHEMA_VERSION,
        sandboxId: stored.version.sandboxId,
        versionId: stored.version.id,
        version: stored.version.version,
        title: stored.version.title,
        specSummary: stored.version.specSummary,
        complexity: stored.version.complexity,
        tags: [...stored.version.tags],
        commands: SANDBOX_COMMANDS,
        toolchain: SANDBOX_TOOLCHAIN,
        editablePaths,
        publicTests,
        testSummary: [{ label: "Public tests", count: publicTests.length }],
      };
      const files: GeneratedFile[] = [
        ...upload.files
          .filter((file) => file.path !== TASK_DESCRIPTOR_PATH)
          .map((file) => ({
            path: file.path,
            text: file.text,
            class: classOf(file.path, layout, generated),
            public: true,
          })),
        {
          path: TASK_DESCRIPTOR_PATH,
          text: `${JSON.stringify(descriptor, null, 2)}\n`,
          class: "descriptor" as const,
          public: true,
        },
      ];
      for (const test of upload.acceptanceTests)
        if (held.has(test.path))
          blockers.push({
            code: "baseline_failed",
            file: test.path,
            detail: "An acceptance test is at a path the folder already holds.",
          });
      const hidden: GeneratedFile[] = upload.acceptanceTests.map((test) => ({
        path: test.path,
        text: test.text,
        class: "test-private",
        public: false,
      }));
      input.log(
        `Uploaded folder: ${files.length} files, ${editablePaths.length} editable, ${hidden.length} acceptance test(s).`,
      );
      const { baseline, evaluator } =
        blockers.length > 0
          ? { baseline: null, evaluator: null }
          : await baselineOf(options.provider, {
              label: params.sandboxVersionId,
              files,
              acceptanceTests: upload.acceptanceTests.map((test) => ({
                ...test,
                expectedBaseline: "fail",
              })),
              blockers,
              signal: input.signal,
              log: input.log,
              now,
              layout,
              timing: input.timing,
            });
      const { written } = await writeBuildOutputs({
        outDir: input.outDir,
        toolVersion: SANDBOX_IMPORT_TOOL_VERSION,
        sandboxVersionId: params.sandboxVersionId,
        bindings: {
          sourceSnapshotId: null,
          sourceCommitSha: null,
          sliceRunId: null,
          manifestSha256: null,
          contractSha256: null,
          starterSha256: params.uploadSha256,
          transformConfigSha256: stored.source.transformConfigSha256,
          approvedTaskSha256: stored.source.approvedTaskSha256,
        },
        aliasRules: [],
        files: [...files, ...hidden],
        importRewrites: [],
        renames: [],
        dependencies: [],
        baseline,
        evaluator,
        blockers,
        layout,
        upload: {
          recordSha256: params.recordSha256,
          carveoutVersion: params.carveoutVersion,
        },
      });
      return written;
    },
    async committed({ runId, files, inputs }) {
      const manifestFile = files.find(
        (item) => item.path === "build-manifest.json",
      );
      if (manifestFile === undefined) return;
      const manifest = JSON.parse(
        await readFile(manifestFile.absolutePath, "utf8"),
      ) as SandboxBuildManifest;
      const testSummary = await descriptorTestSummary(files);
      await inputs.recordStarterOutput(manifest.sandboxVersionId, runId, {
        starterSha256: manifest.starterSha256 ?? "",
        aliasRules: [],
        // The hidden tests stay in the run's private artifacts.
        acceptanceTests: [],
        scope: {
          editablePaths: [],
          generatedPaths: [],
          permittedOperations: ["edit", "add"],
          dependencies: [],
          blockers: [],
        },
        transformConfigSha256: manifest.transformConfigSha256,
        build: manifest.ready
          ? {
              harnessSha256: manifest.harnessSha256,
              toolchainDigest: manifest.toolchainDigest,
            }
          : null,
        ...(testSummary === undefined ? {} : { testSummary }),
      });
    },
  };
}
