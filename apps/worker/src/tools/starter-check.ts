/**
 * Whether a starter builds: its rules, its name table applied, the project
 * the renamed starter generates, no public file of it naming the
 * workspace, and a type check of that project as `npm run build` would
 * run it.
 *
 * The listing (the version's title, summary and tags, which the README and
 * the descriptor carry) is the bounty's own text, renamed with the rest.
 * A workspace name left anywhere a developer reads is a `vocabulary_leaked`
 * problem, as it blocks a sliced build.
 *
 * The check runs in memory, with the generated `tsconfig.json`, the
 * harness's ambient declarations and nothing installed, so packages compile
 * as `any`, exactly as they do in the project itself. Every diagnostic is
 * the starter's own, in the public names the project is written in.
 */

import ts from "typescript-compiler";
import {
  aliasStarter,
  generateStarterProject,
  starterProblems,
  vocabularyBlockers,
  vocabularyLeaks,
} from "sandbox-factory";
import type {
  GeneratedProject,
  ProjectVersion,
  SpecDraft,
  StarterSubmission,
} from "sandbox-factory";
import { compileFixture } from "./slice/fixture.js";

const PROBLEMS_MAX = 40;

export type StarterCheck =
  | { readonly ok: false; readonly problems: readonly string[] }
  | {
      readonly ok: true;
      readonly problems: readonly [];
      readonly project: GeneratedProject;
      /** The starter in public names: what the project was generated from. */
      readonly starter: StarterSubmission;
    };

export function checkStarter(input: {
  /** Any absolute directory; nothing is read from it. */
  readonly root: string;
  readonly version: ProjectVersion;
  readonly starter: StarterSubmission;
  readonly spec: SpecDraft | null;
  /** The workspace's names (`workspaceVocabulary`), which no public file may carry. */
  readonly vocabulary: readonly string[];
}): StarterCheck {
  const ruled = starterProblems(input.starter);
  if (ruled.length > 0)
    return { ok: false, problems: ruled.slice(0, PROBLEMS_MAX) };
  const aliased = aliasStarter(input.starter, input.spec, {
    listing: {
      title: input.version.title,
      specSummary: input.version.specSummary,
      tags: input.version.tags,
    },
  });
  if (!aliased.ok)
    return { ok: false, problems: aliased.problems.slice(0, PROBLEMS_MAX) };
  const starter = aliased.starter;
  const project = generateStarterProject({
    version: { ...input.version, ...aliased.listing },
    starter,
    acceptanceTests: starter.hiddenTests,
    spec: aliased.spec,
  });
  const problems = [
    ...project.blockers,
    ...vocabularyBlockers(
      vocabularyLeaks(
        project.files.filter((file) => file.public),
        input.vocabulary,
      ),
    ),
  ]
    .filter((blocker) => blocker.code !== "starter_invalid")
    .map((blocker) =>
      blocker.file === null
        ? blocker.detail
        : `${blocker.file}: ${blocker.detail}`,
    );
  if (problems.length > 0)
    return { ok: false, problems: problems.slice(0, PROBLEMS_MAX) };
  const files = new Map(project.files.map((file) => [file.path, file.text]));
  const tsconfig = JSON.parse(files.get("tsconfig.json") ?? "{}") as {
    compilerOptions?: Record<string, unknown>;
  };
  const result = compileFixture({
    root: input.root,
    files,
    compilerOptions: ts.convertCompilerOptionsFromJson(
      tsconfig.compilerOptions ?? {},
      input.root,
    ).options,
    shimmedPackages: starter.packages.map((item) => item.name),
  });
  const diagnostics = result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.file ?? "(project)"}${diagnostic.line === null ? "" : `:${diagnostic.line}`} ${diagnostic.code} ${diagnostic.message}`,
  );
  return diagnostics.length === 0
    ? { ok: true, problems: [], project, starter }
    : { ok: false, problems: diagnostics.slice(0, PROBLEMS_MAX) };
}
