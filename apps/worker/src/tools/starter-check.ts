/**
 * Whether a starter builds: its rules, its name table applied, the project
 * the renamed starter generates, no public file of it naming the
 * workspace, and a type check of that project as `npm run build` would
 * run it.
 *
 * The listing (the version's title, summary and tags, which the README and
 * the descriptor carry) is the bounty's own text, renamed with the rest.
 * A workspace name left anywhere a developer reads is a `vocabulary_leaked`
 * problem, as it blocks a sliced build. So is what the disclosure scan
 * finds beyond the names in a public file (`scanDisclosure`: an address, a
 * host, an author, a ticket key, a chat link); the agent renames it with a
 * text pseudonym. No owner's acknowledgement is read here, so what the
 * agent writes never depends on the draft's list: publication checks the
 * list against what the build recorded (`gatesOf`). The bounty's own words
 * (the listing, the spec and the decisions) are redacted of those by
 * construction (`redactDisclosure`), as a sliced build redacts them, so a
 * link in the bounty never refuses a starter.
 *
 * The check runs in memory, with the generated `tsconfig.json`, the
 * harness's ambient declarations and nothing installed, so packages compile
 * as `any`, exactly as they do in the project itself. Every diagnostic is
 * the starter's own, in the public names the project is written in.
 */

import ts from "typescript-compiler";
import {
  aliasStarter,
  disclosableDecisions,
  generateStarterProject,
  redactDisclosure,
  scanDisclosure,
  specDecisions,
  starterProblems,
  vocabularyBlockers,
} from "sandbox-factory";
import type {
  AcceptanceTest,
  DisclosureContext,
  GeneratedProject,
  ProjectVersion,
  SpecDraft,
  StarterSubmission,
} from "sandbox-factory";
import { compileFixture } from "carveout/extract";
import { publicLeaks } from "./vocabulary-check.js";

const PROBLEMS_MAX = 40;

/**
 * Where a starter stopped: its own rules, its name table, the project it
 * generates (a blocker or a workspace name left in a public file), or the
 * type check. Only `types` is a starter that does not compile.
 */
export type StarterCheckStage = "rules" | "names" | "project" | "types";

export type StarterCheck =
  | {
      readonly ok: false;
      readonly stage: StarterCheckStage;
      readonly problems: readonly string[];
    }
  | {
      readonly ok: true;
      readonly problems: readonly [];
      readonly project: GeneratedProject;
      /** The starter in public names: what the project was generated from. */
      readonly starter: StarterSubmission;
      /** The spec in public names, as the project carries it. */
      readonly spec: SpecDraft | null;
      /** The confirmed decisions in public names; none when unconfirmed. */
      readonly decisions: readonly string[];
      /**
       * The same project with other hidden tests, in public names: what
       * calibration builds its reference and a kept subset from.
       */
      readonly regenerate: (
        tests: readonly AcceptanceTest[],
      ) => GeneratedProject;
    };

export function checkStarter(input: {
  /** Any absolute directory; nothing is read from it. */
  readonly root: string;
  readonly version: ProjectVersion;
  readonly starter: StarterSubmission;
  readonly spec: SpecDraft | null;
  /** The spec's confirmed decisions, in the bounty's names; none when unconfirmed. */
  readonly decisions?: readonly string[];
  /** The workspace's names (`workspaceVocabulary`), which no public file may carry. */
  readonly vocabulary: readonly string[];
  /** The workspace's Jira project keys (`SandboxBuildParams.ticketKeys`). */
  readonly ticketKeys?: readonly string[];
}): StarterCheck {
  const ruled = starterProblems(input.starter);
  if (ruled.length > 0)
    return {
      ok: false,
      stage: "rules",
      problems: ruled.slice(0, PROBLEMS_MAX),
    };
  const aliased = aliasStarter(input.starter, input.spec, {
    listing: {
      title: input.version.title,
      specSummary: input.version.specSummary,
      tags: input.version.tags,
    },
  });
  if (!aliased.ok)
    return {
      ok: false,
      stage: "names",
      problems: aliased.problems.slice(0, PROBLEMS_MAX),
    };
  const starter = aliased.starter;
  // The scan's context: the names the table wrote are the public ones.
  const context: DisclosureContext = {
    ticketKeys: input.ticketKeys ?? [],
    publicNames: starter.aliases.map((rule) => rule.after),
  };
  const scrub = (text: string) => redactDisclosure(text, context);
  // The bounty's words as the project carries them: renamed, then
  // redacted of what still says where they came from.
  const spec = aliased.spec === null ? null : scrubbed(aliased.spec, scrub);
  const renamed = aliased.listing ?? input.version;
  const listing = {
    title: scrub(renamed.title),
    specSummary: scrub(renamed.specSummary),
    tags: renamed.tags.map(scrub),
  };
  // Renamed with the spec, and in `TASK.md` only when the scans pass them.
  const decisions =
    (input.decisions ?? []).length === 0 || spec === null
      ? []
      : specDecisions(spec).map(({ text }) => text);
  const generate = (tests: readonly AcceptanceTest[]) =>
    generateStarterProject({
      version: { ...input.version, ...listing },
      starter,
      acceptanceTests: tests,
      spec,
      decisions: disclosableDecisions(decisions, input.vocabulary),
    });
  const project = generate(starter.hiddenTests);
  // Another set of tests is calibration's, not the starter's: the starter's
  // own rules were checked above, and one of them (a test that fails) is
  // what a reference's set, every test passing, breaks by design.
  const regenerate = (tests: readonly AcceptanceTest[]) => {
    const made = generate(tests);
    return {
      ...made,
      blockers: made.blockers.filter(
        (blocker) => blocker.code !== "starter_invalid",
      ),
    };
  };
  const blockers = project.blockers.filter(
    (blocker) => blocker.code !== "starter_invalid",
  );
  const publicFiles = project.files.filter((file) => file.public);
  const leaks = vocabularyBlockers(publicLeaks(publicFiles, input.vocabulary));
  // What says whose code it is beyond the names, in what the agent wrote.
  const found = scanDisclosure(publicFiles, context).map(
    (finding) =>
      `${finding.file}:${finding.line}: ${finding.kind} ${finding.value} may say whose code this is. Rename it with a text pseudonym (a reserved example.com, .example or .test name), or leave it out.`,
  );
  const problems = [
    ...[...blockers, ...leaks].map((blocker) =>
      blocker.file === null
        ? blocker.detail
        : `${blocker.file}: ${blocker.detail}`,
    ),
    ...found,
  ];
  // A workspace name left behind is the name table's to fix, not the project's.
  if (problems.length > 0)
    return {
      ok: false,
      stage: blockers.length === 0 ? "names" : "project",
      problems: problems.slice(0, PROBLEMS_MAX),
    };
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
    ? {
        ok: true,
        problems: [],
        project,
        starter,
        spec,
        decisions,
        regenerate,
      }
    : {
        ok: false,
        stage: "types",
        problems: diagnostics.slice(0, PROBLEMS_MAX),
      };
}

/** A JSON value with every string leaf passed through `map`, keys kept. */
function scrubbed<T>(value: T, map: (text: string) => string): T {
  const walk = (item: unknown): unknown =>
    typeof item === "string"
      ? map(item)
      : Array.isArray(item)
        ? item.map(walk)
        : item !== null && typeof item === "object"
          ? Object.fromEntries(
              Object.entries(item).map(([key, entry]) => [key, walk(entry)]),
            )
          : item;
  return walk(value) as T;
}
