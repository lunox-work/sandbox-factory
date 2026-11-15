/**
 * The repository's own tests that exercise a slice, carried into its
 * project as read-only public tests under `tests/public/carried/`, so the
 * contributor's `npm test` and grading's public suite run what the
 * repository already checks of that code.
 *
 * Which tests: those the slice's walk saw importing a file of the slice
 * (`manifest.cuts.inbound`, from a test path, not itself in the slice),
 * whatever slice they come from, so a slice cut before tests were carried
 * names them too. A slice's request decides whether its builds carry them
 * (`SliceParams.carryTests`, absent on old slices: none) and how many
 * (`carriedTestLimits`, else `CARRIED_TEST_LIMITS`).
 *
 * A test is carried only when the project can run it as written: a
 * TypeScript `.test.ts(x)` on `node:test` (Vitest and Jest are not
 * installed in a sliced project), every import a Node module, a package
 * the project installs or mocks, a file of the slice or a module it stubs.
 * Anything else is dropped with its reason, never repaired. The build then
 * renames each by the version's table at its repository path
 * (`carriedTestFile`), scans it like any public file, and keeps only those
 * that pass, twice, on the untouched project in its baseline's own job.
 * The build manifest records what was carried and what was dropped and
 * why (`CarriedTestsRecord`), for owners only.
 *
 * Grading needs nothing new: the files are under `tests/`, which no
 * submission writes (`GradingLayout.harnessRoots`), and the public suite's
 * glob runs them. The reversed check puts each back at
 * `tests/public/carried/<repository path>` in the repository's names, its
 * imports pointed again at where their targets went
 * (`reversedCarriedTest`).
 */

import type { BoundaryContract, SliceManifest } from "../slice/manifest.js";
import {
  CARRIED_TEST_FILE,
  CARRIED_TESTS_DIR,
  dirnameOf,
  joinRelative,
  relativeSpecifier,
  renameEnvironmentReads,
  replaceScriptImports,
  runtimePath,
  scriptImports,
  sourceCandidates,
} from "./project.js";

/** At most how many tests, and how many bytes of them, a build carries. */
export interface CarriedTestLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

/** A slice's limits when its request names none. */
export const CARRIED_TEST_LIMITS: CarriedTestLimits = {
  maxFiles: 20,
  maxBytes: 256 * 1024,
};

/** How long one carried test may run on the baseline before it is dropped. */
export const CARRIED_TEST_TIMEOUT_MS = 60_000;

/** Why a test of the repository was not carried. */
export const CARRIED_TEST_DROPS = [
  /** Not a `.test.ts(x)`: JavaScript, a declaration or another name. */
  "language",
  /** Vitest, Jest or another runner's globals: the project runs node:test. */
  "runner",
  /** An import of a file neither in the slice nor stubbed by it. */
  "outside_slice",
  /** A package the project neither installs nor mocks. */
  "package_missing",
  /** Past the slice's file or byte limit. */
  "limit",
  /** Not readable at the slice's commit. */
  "unreadable",
  /** The table could not rename it, or changed its imports. */
  "alias_failed",
  /** It names the workspace, a credential or what the disclosure scan finds. */
  "disclosure",
  /** It does not compile against the project. */
  "compile_failed",
  /** It fails, or cannot run, on the untouched project. */
  "baseline_failed",
  /** It ran past `CARRIED_TEST_TIMEOUT_MS`. */
  "timed_out",
  /** Two runs of it disagreed. */
  "flaky",
  /** The build was blocked before its baseline, so it was never tried. */
  "untried",
] as const;
export type CarriedTestDrop = (typeof CARRIED_TEST_DROPS)[number];

export interface DroppedTest {
  /** The test's repository path. */
  readonly from: string;
  readonly reason: CarriedTestDrop;
  readonly detail: string;
}

/** One import of a carried test, in `scriptImports` order. */
export interface CarriedImport {
  readonly specifier: string;
  /** The repository path it reaches: a file of the slice or a stubbed module; null for a package or Node module. */
  readonly target: string | null;
}

/** A test that may be carried, as the repository has it. */
export interface CarriedTestCandidate {
  readonly from: string;
  readonly text: string;
  readonly imports: readonly CarriedImport[];
}

/** What a build recorded of the tests it carried, in its manifest. */
export interface CarriedTestsRecord {
  readonly limits: CarriedTestLimits & { readonly timeoutMs: number };
  /** Carried, by project path, each with its repository path. */
  readonly kept: readonly { readonly path: string; readonly from: string }[];
  readonly dropped: readonly DroppedTest[];
}

/** carveout's test files: `.test`/`.spec` scripts, or anything under `__tests__/`. */
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The repository tests the slice's walk saw import its files, sorted. */
export function carriedTestPaths(
  manifest: Pick<SliceManifest, "cuts" | "included">,
): string[] {
  const included = new Set(manifest.included.map((file) => file.path));
  return [
    ...new Set(
      manifest.cuts.inbound
        .map((edge) => edge.from)
        .filter((from) => TEST_PATH.test(from) && !included.has(from)),
    ),
  ].sort(compare);
}

/** Whether a specifier names a Node module or a package, not a file. */
const bare = (specifier: string) =>
  !specifier.startsWith(".") && !specifier.startsWith("/");

/**
 * The repository's tests a build may carry, statically checked, and the
 * rest with why. `texts` holds each of `carriedTestPaths` the build could
 * read; `installs` says whether the project installs or mocks a bare
 * specifier's package (a Node module included). The limits take tests in
 * path order.
 */
export function carriedTestCandidates(input: {
  readonly manifest: Pick<SliceManifest, "cuts" | "included">;
  readonly contract: Pick<BoundaryContract, "outbound">;
  readonly texts: ReadonlyMap<string, string>;
  readonly installs: (specifier: string) => boolean;
  readonly limits: CarriedTestLimits;
}): { candidates: CarriedTestCandidate[]; dropped: DroppedTest[] } {
  const { manifest } = input;
  const reachable = new Set([
    ...manifest.included.map((file) => file.path),
    ...input.contract.outbound
      .filter((module) => module.stubPath !== null)
      .map((module) => module.module),
  ]);
  const candidates: CarriedTestCandidate[] = [];
  const dropped: DroppedTest[] = [];
  let bytes = 0;
  for (const from of carriedTestPaths(manifest)) {
    const drop = (reason: CarriedTestDrop, detail: string) =>
      dropped.push({ from, reason, detail });
    const text = input.texts.get(from);
    if (text === undefined) {
      drop("unreadable", "It could not be read at the slice's commit.");
      continue;
    }
    if (!CARRIED_TEST_FILE.test(from)) {
      drop(
        "language",
        "Only a TypeScript `.test.ts` or `.test.tsx` file is carried: the project compiles TypeScript in place and `npm test` runs `*.test.js`.",
      );
      continue;
    }
    const specifiers = scriptImports(text);
    if (
      specifiers.some(
        (specifier) =>
          specifier === "vitest" || specifier.startsWith("vitest/"),
      )
    ) {
      drop("runner", "It runs on Vitest; a sliced project runs node:test.");
      continue;
    }
    if (!specifiers.includes("node:test")) {
      drop(
        "runner",
        "It imports no `node:test`: Jest's or another runner's globals, which a sliced project does not install.",
      );
      continue;
    }
    const edges = manifest.cuts.inbound.filter((edge) => edge.from === from);
    const imports: CarriedImport[] = [];
    let problem: { reason: CarriedTestDrop; detail: string } | null = null;
    for (const specifier of specifiers) {
      const edge = edges.find((each) => each.specifier === specifier);
      if (edge !== undefined && reachable.has(edge.to)) {
        imports.push({ specifier, target: edge.to });
        continue;
      }
      if (bare(specifier)) {
        if (specifier.startsWith("node:") || input.installs(specifier)) {
          imports.push({ specifier, target: null });
          continue;
        }
        problem = {
          reason: "package_missing",
          detail: `It imports \`${specifier}\`, which the project neither installs nor mocks.`,
        };
        break;
      }
      const joined = joinRelative(dirnameOf(from), specifier);
      const target =
        joined === null
          ? undefined
          : [joined, ...sourceCandidates(joined)].find((path) =>
              reachable.has(path),
            );
      if (target === undefined) {
        problem = {
          reason: "outside_slice",
          detail: `It imports \`${specifier}\`, which is neither in the slice nor stubbed by it.`,
        };
        break;
      }
      imports.push({ specifier, target });
    }
    if (problem !== null) {
      drop(problem.reason, problem.detail);
      continue;
    }
    const size = new TextEncoder().encode(text).length;
    if (
      candidates.length >= input.limits.maxFiles ||
      bytes + size > input.limits.maxBytes
    ) {
      drop(
        "limit",
        `Past the slice's limit of ${input.limits.maxFiles} carried test(s) and ${input.limits.maxBytes} bytes.`,
      );
      continue;
    }
    bytes += size;
    candidates.push({ from, text, imports });
  }
  return { candidates, dropped };
}

/**
 * A candidate as the project carries it, from its text renamed by the
 * version's table at its repository path (`renamed`): at
 * `tests/public/carried/<renamed path>`, each import of a file pointed at
 * where the project put it (`projectPathOf`), a mocked package by its
 * public name (`packageName`), and the environment it reads by the table's
 * names. A dropped test when the renaming changed its imports or a target
 * has no place in the project.
 */
export function carriedTestFile(input: {
  readonly candidate: CarriedTestCandidate;
  readonly renamed: { readonly path: string; readonly text: string };
  readonly projectPathOf: (repositoryPath: string) => string | null;
  readonly packageName: (specifier: string) => string;
  readonly environment: ReadonlyMap<string, string>;
}): { path: string; text: string } | DroppedTest {
  const { candidate } = input;
  const path = `${CARRIED_TESTS_DIR}/${input.renamed.path}`;
  const drop = (reason: CarriedTestDrop, detail: string): DroppedTest => ({
    from: candidate.from,
    reason,
    detail,
  });
  if (!CARRIED_TEST_FILE.test(path))
    return drop("alias_failed", "The table renamed it out of a test name.");
  if (scriptImports(input.renamed.text).length !== candidate.imports.length)
    return drop("alias_failed", "The table changed its imports.");
  let missing: string | null = null;
  const text = replaceScriptImports(input.renamed.text, (index, specifier) => {
    const target = candidate.imports[index]?.target ?? null;
    if (target === null) return input.packageName(specifier);
    const to = input.projectPathOf(target);
    if (to === null) {
      missing ??= target;
      return specifier;
    }
    return relativeSpecifier(path, to);
  });
  if (missing !== null)
    return drop(
      "outside_slice",
      `It imports ${missing}, which the project does not hold.`,
    );
  return { path, text: renameEnvironmentReads(text, input.environment) };
}

/**
 * A carried test in the repository's names, for the reversed check: the
 * text the table's inverse gave (`reversedText`), with each relative
 * import of its public text pointed again at where its target went
 * (`reversedOf`, by the public path of the file the import lands on;
 * `holds` says which public paths there are). The renaming leaves the
 * imports where they were, so the k-th of each is the same import; when
 * they do not line up, the inverse's text stands.
 */
export function reversedCarriedTest(input: {
  readonly publicPath: string;
  readonly publicText: string;
  readonly reversedPath: string;
  readonly reversedText: string;
  readonly holds: (publicPath: string) => boolean;
  readonly reversedOf: (publicPath: string) => string | null;
}): string {
  const publicImports = scriptImports(input.publicText);
  if (scriptImports(input.reversedText).length !== publicImports.length)
    return input.reversedText;
  return replaceScriptImports(input.reversedText, (index, specifier) => {
    const written = publicImports[index] ?? "";
    if (bare(written)) return specifier;
    const joined = joinRelative(dirnameOf(input.publicPath), written);
    if (joined === null) return specifier;
    const landed = [joined, ...sourceCandidates(joined)].find(input.holds);
    const reversed = landed === undefined ? null : input.reversedOf(landed);
    if (reversed === null) return specifier;
    // A source keeps its extension in the tree; the import names its output.
    return relativeSpecifier(input.reversedPath, runtimePath(reversed));
  });
}
