/**
 * The grading adapter: a submission's files applied to the built version it
 * was made against (`gradingTree`), and the version's own suites run on the
 * result in a fresh evaluation job, with every hidden test expected to pass.
 * duediligence's rule (`duediligence/api` `verdict`) turns the outcomes into
 * the verdict: refused, incomplete, overfit or passed.
 *
 * Before anything runs, carveout's hand-off policy (`gainedIntegrity`)
 * refuses a file that gains a way to pass a test without the code: telling
 * a test run from a real one, exiting early, rewriting the assertions.
 *
 * A passing submission on a version sliced from a repository is carried
 * back to the repository's names on the commit the version was cut at
 * (`reverseSubmission`), and kept as `private/merge-patch.json` for
 * merge-back; one that cannot be carried back is refused, so nothing that
 * passed here fails to map at the pull request.
 *
 * Only counts, the verdict and the scenario keys of failing hidden tests
 * (`s1`, from the file names the hidden-tests scaffold writes) leave the
 * run, in `submission-result.json` and on the submission. A hidden test's
 * name, body and output stay in the run's private log.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gainedIntegrity } from "carveout/api";
import { verdict as judge } from "duediligence/api";
import type { SuiteResult } from "duediligence/api";
import {
  PRIVATE_TESTS_DIR,
  PSEUDONYMS_FILE,
  SUBMISSION_GRADE_TOOL_VERSION,
  TASK_DESCRIPTOR_PATH,
  gradingTree,
  isSubmissionGradeParams,
  reverseSubmission,
} from "sandbox-factory";
import type {
  AcceptanceTest,
  BaselineReport,
  EvaluationProvider,
  GeneratedFile,
  AliasRule,
  ProjectBlocker,
  SandboxBuildManifest,
  SubmissionResult,
} from "sandbox-factory";
import { AnalysisError } from "../errors.js";
import type { ArtifactFile, ToolAdapter, ToolRunInput } from "./adapter.js";
import { baselineOf } from "./sandbox-build.js";

export const SUBMISSION_RESULT_PATH = "submission-result.json";
/** A passing submission carried back to the repository: merge-back's input. */
export const MERGE_PATCH_PATH = "private/merge-patch.json";
export const MERGE_PATCH_SCHEMA_VERSION = 1;

/** `private/merge-patch.json`. */
export interface MergePatch {
  readonly schemaVersion: typeof MERGE_PATCH_SCHEMA_VERSION;
  /** The commit the version was sliced at: the patch's base. */
  readonly commitSha: string;
  /** Each changed file, whole, at its repository path. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
}
/** A hidden test's file name says the scenario it covers: `s3-…test.ts`. */
const SCENARIO = /^(s\d+)-/;
const PUBLIC_ID = "tests/public :: suite";
const FILE_TEST = "(file)";

/**
 * The built version's files as a grading tree reads them: the public
 * project at its paths, the hidden tests at `tests/private/…`.
 */
export async function versionFilesOf(
  input: Pick<ToolRunInput, "inputs">,
  buildRunId: string,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const artifact of await input.inputs.listArtifacts(buildRunId)) {
    const isProject = artifact.path.startsWith("project/");
    const isHidden =
      artifact.path.startsWith("private/") &&
      artifact.path.endsWith(".test.ts");
    if (!isProject && !isHidden) continue;
    const bytes = await input.inputs.readArtifact(artifact.objectKey);
    if (bytes === undefined) throw new AnalysisError("tool_failed");
    const text = Buffer.from(bytes).toString("utf8");
    files.push(
      isProject
        ? {
            path: artifact.path.slice("project/".length),
            text,
            class: "source",
            public: true,
          }
        : {
            path: `${PRIVATE_TESTS_DIR}/${artifact.path.slice("private/".length)}`,
            text,
            class: "test-private",
            public: false,
          },
    );
  }
  return files;
}

/** Files a sandbox has that its repository has not. */
const HARNESS_CLASSES: ReadonlySet<string> = new Set([
  "mock",
  "harness",
  "test-public",
  "test-private",
]);

/** A build artifact's text, by its path in the build run; null for none. */
async function buildArtifactText(
  input: Pick<ToolRunInput, "inputs">,
  buildRunId: string,
  path: string,
): Promise<string | null> {
  const artifact = (await input.inputs.listArtifacts(buildRunId)).find(
    (item) => item.path === path,
  );
  if (artifact === undefined) return null;
  const bytes = await input.inputs.readArtifact(artifact.objectKey);
  return bytes === undefined ? null : Buffer.from(bytes).toString("utf8");
}

/** A file of the extracted source, kept inside it; null for none. */
export function sourceText(sourceDir: string, path: string): string | null {
  const absolute = resolve(sourceDir, path);
  const rel = relative(sourceDir, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/**
 * A passing submission carried back to the repository at the version's
 * commit, from the build's name table and moved paths.
 */
export async function carriedBack(
  input: Pick<ToolRunInput, "inputs" | "sourceDir">,
  buildRunId: string,
  versionFiles: readonly GeneratedFile[],
  submitted: readonly { readonly path: string; readonly text: string }[],
) {
  const manifestText = await buildArtifactText(
    input,
    buildRunId,
    "build-manifest.json",
  );
  const tableText = await buildArtifactText(
    input,
    buildRunId,
    `private/${PSEUDONYMS_FILE}`,
  );
  if (manifestText === null || tableText === null)
    throw new AnalysisError("tool_failed");
  const manifest = JSON.parse(manifestText) as Pick<
    SandboxBuildManifest,
    "renames" | "files"
  >;
  const table = JSON.parse(tableText) as { rules: AliasRule[] };
  const project = new Map(
    versionFiles
      .filter((file) => file.public)
      .map((file) => [file.path, file.text]),
  );
  return reverseSubmission({
    submitted,
    publicText: (path) => project.get(path) ?? null,
    repositoryText: (path) => sourceText(input.sourceDir, path),
    rules: table.rules,
    renames: manifest.renames,
    // A stub stands for a module the repository has; the rest it has not.
    harness: manifest.files
      .filter((record) => HARNESS_CLASSES.has(record.class))
      .map((record) => record.path),
  });
}

/**
 * The submitted files that gain a way to pass without the code over the
 * version's own text (`gainedIntegrity`), each with the ways it gained.
 */
export function integrityRefusals(
  versionFiles: readonly GeneratedFile[],
  submitted: readonly { readonly path: string; readonly text: string }[],
): { path: string; reason: string }[] {
  const before = new Map(
    versionFiles
      .filter((file) => file.public)
      .map((file) => [file.path, file.text]),
  );
  return submitted.flatMap(({ path, text }) => {
    const gained = gainedIntegrity(path, before.get(path) ?? null, text);
    return gained.length === 0
      ? []
      : [
          {
            path,
            reason: `It adds a way to pass the tests without the code: ${gained.join(", ")}.`,
          },
        ];
  });
}

/** The outcome of a graded tree, as duediligence's rule reads it. */
export function resultOf(input: {
  readonly hiddenPaths: readonly string[];
  readonly baseline: BaselineReport | null;
  readonly refused: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}): SubmissionResult {
  const kept = input.hiddenPaths.map((path) => `${path} :: ${FILE_TEST}`);
  if (input.refused.length > 0 || input.baseline === null) {
    const judged = judge({
      public: null,
      hidden: null,
      publicIds: [PUBLIC_ID],
      kept,
      refused: input.refused.map(({ path, reason }) => ({
        path,
        change: "changed",
        reason,
      })),
    });
    return {
      public: judged.public,
      hidden: judged.hidden,
      verdict: judged.verdict === "refused" ? "refused" : "incomplete",
      failedScenarios: [],
      refused: input.refused,
    };
  }
  const { baseline } = input;
  const step = (name: string) =>
    baseline.steps.find((each) => each.name === name);
  const built = step("build")?.ok === true;
  const publicSuite: SuiteResult = {
    compiled: built,
    files: [
      {
        file: "tests/public",
        crashed: false,
        timedOut: false,
        tests: [
          {
            name: "suite",
            ok: step("public-tests")?.ok === true,
            skipped: false,
            error: null,
          },
        ],
      },
    ],
  };
  const observed = new Map(
    baseline.privateTests.map((outcome) => [outcome.path, outcome.observed]),
  );
  const hiddenSuite: SuiteResult = {
    compiled: built,
    files: input.hiddenPaths.flatMap((path) => {
      const seen = observed.get(path);
      return seen === undefined
        ? []
        : [
            {
              file: path,
              crashed: seen === "error" || seen === "flaky",
              timedOut: false,
              tests: [
                {
                  name: FILE_TEST,
                  ok: seen === "pass",
                  skipped: false,
                  error: seen === "pass" ? null : { message: "failed" },
                },
              ],
            },
          ];
    }),
  };
  const judged = judge({
    public: publicSuite,
    hidden: hiddenSuite,
    publicIds: [PUBLIC_ID],
    kept,
  });
  const failedScenarios = [
    ...new Set(
      judged.failures.flatMap(({ id }) => {
        const name = id.split(" :: ")[0]?.split("/").at(-1) ?? "";
        const key = SCENARIO.exec(name)?.[1];
        return key === undefined ? [] : [key];
      }),
    ),
  ].sort();
  return {
    public: judged.public,
    hidden: judged.hidden,
    verdict: judged.verdict === "regressed" ? "incomplete" : judged.verdict,
    failedScenarios,
  };
}

export function createSubmissionGradeAdapter(options: {
  readonly provider: EvaluationProvider | null;
  readonly now?: () => Date;
}): ToolAdapter {
  const now = options.now ?? (() => new Date());
  return {
    name: "submission_grade",
    version: SUBMISSION_GRADE_TOOL_VERSION,
    async run(input: ToolRunInput): Promise<ArtifactFile[]> {
      const params = input.params;
      if (!isSubmissionGradeParams(params))
        throw new AnalysisError("tool_failed");
      if (options.provider === null) {
        input.log("No evaluation provider is configured on this worker.");
        throw new AnalysisError("evaluation_failed");
      }
      const runId = input.runId ?? "";
      const read = await input.inputs.readSubmission?.(params.submissionId);
      if (read === null || read === undefined)
        throw new AnalysisError("tool_failed");
      const stored = await input.inputs.getVersion(params.sandboxVersionId);
      const buildRunId = stored?.source.buildRunId ?? null;
      if (stored === null || buildRunId === null)
        throw new AnalysisError("tool_failed");
      const versionFiles = await versionFilesOf(input, buildRunId);
      const descriptor = versionFiles.find(
        (file) => file.path === TASK_DESCRIPTOR_PATH,
      );
      const editablePaths =
        (JSON.parse(descriptor?.text ?? "{}") as { editablePaths?: string[] })
          .editablePaths ?? [];
      const tree = gradingTree({
        versionFiles,
        editablePaths,
        submission: read.files,
      });
      const refused = [
        ...tree.refused,
        ...integrityRefusals(versionFiles, read.files),
      ];
      const hiddenPaths = versionFiles
        .filter((file) => file.class === "test-private")
        .map((file) => file.path)
        .sort();
      let baseline: BaselineReport | null = null;
      if (refused.length === 0) {
        const acceptanceTests: AcceptanceTest[] = versionFiles
          .filter((file) => file.class === "test-private")
          .map((file) => ({
            path: file.path,
            text: file.text,
            expectedBaseline: "pass",
          }));
        const blockers: ProjectBlocker[] = [];
        baseline = (
          await baselineOf(options.provider, {
            label: params.submissionId,
            files: [...tree.files],
            acceptanceTests,
            blockers,
            signal: input.signal,
            log: input.log,
            now,
          })
        ).baseline;
      }
      let result = resultOf({ hiddenPaths, baseline, refused });
      const written: ArtifactFile[] = [];
      // A version sliced from a repository: carry a pass back to it.
      if (result.verdict === "passed" && input.run !== null) {
        const carried = await carriedBack(
          input,
          buildRunId,
          versionFiles,
          read.files,
        );
        if (carried.refused.length > 0)
          result = { ...result, verdict: "refused", refused: carried.refused };
        else {
          const patch: MergePatch = {
            schemaVersion: MERGE_PATCH_SCHEMA_VERSION,
            commitSha: input.run.commitSha,
            files: carried.files,
          };
          const absolutePath = join(input.outDir, MERGE_PATCH_PATH);
          await mkdir(join(input.outDir, "private"), { recursive: true });
          await writeFile(absolutePath, JSON.stringify(patch), "utf8");
          written.push({
            path: MERGE_PATCH_PATH,
            absolutePath,
            kind: "other",
            contentType: "application/json",
            meta: { files: carried.files.length },
          });
        }
      }
      input.log(
        `Submission ${params.submissionId}: ${result.verdict ?? ""}, public ${result.public.passed}/${result.public.total}, hidden ${result.hidden.passed}/${result.hidden.total}.`,
      );
      await input.inputs.finishSubmission?.(params.submissionId, runId, result);
      const absolutePath = join(input.outDir, SUBMISSION_RESULT_PATH);
      await writeFile(absolutePath, JSON.stringify(result), "utf8");
      return [
        ...written,
        {
          path: SUBMISSION_RESULT_PATH,
          absolutePath,
          kind: "other",
          contentType: "application/json",
          meta: { verdict: result.verdict ?? null },
        },
      ];
    },
  };
}
