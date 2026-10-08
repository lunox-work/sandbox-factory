/**
 * The arithmetic behind home's two free insights, kept out of the components
 * so it can be tested without rendering anything.
 *
 * - **A backlog scan** is the board's `backlog-preview`: every open ticket
 *   classified against the six categories by rules over its metadata. This
 *   turns it into what the scan says — how many tickets fit, which category
 *   to open on, which tickets to show first.
 * - **A repository x-ray** is a snapshot's tree facts. This picks the
 *   modules a first bounty is easiest to cut from.
 *
 * Neither makes a model call, and neither is a promise about the work: they
 * say where to look, and sizing says what the work is.
 */

import type {
  JiraBacklogPreviewDto,
  TreeFactsDto,
} from "@sandbox-factory/shared";

type PreviewIssue = JiraBacklogPreviewDto["issues"][number];

export interface ScanSummary {
  /**
   * Distinct tickets that fit at least one category, those already proposed
   * included: a ticket in two categories is one ticket here, though each
   * category's count has it.
   */
  readonly fitting: number;
  /** Open tickets read, before sub-task parents were set aside. */
  readonly scanned: number;
  /** Fitting tickets still to size: the candidates the scan lists. */
  readonly candidates: number;
  /** Tickets already proposed, which the scan does not offer again. */
  readonly proposed: number;
  /** Counts are a lower bound: the read stopped before the board did. */
  readonly partial: boolean;
}

export function scanSummary(preview: JiraBacklogPreviewDto): ScanSummary {
  const candidates = preview.issues.filter(
    (issue) => (issue.categories ?? []).length > 0,
  ).length;
  return {
    fitting: candidates + preview.skippedLive,
    scanned: preview.candidatesScanned,
    candidates,
    proposed: preview.skippedLive,
    partial: preview.scanLimitReached || preview.ticketCapReached,
  };
}

/** The tickets still to size in one category, oldest first as read. */
export function candidatesIn(
  preview: JiraBacklogPreviewDto,
  category: string,
): PreviewIssue[] {
  return preview.issues.filter((issue) =>
    (issue.categories ?? []).some(({ id }) => id === category),
  );
}

/**
 * The category the scan opens on: the one with the most tickets still to
 * size, ties to the registry's order. Null when nothing fits any.
 *
 * Counted over candidates rather than the board's totals, so the scan never
 * opens on a category whose every ticket is already proposed.
 */
export function openingCategory(preview: JiraBacklogPreviewDto): string | null {
  let best: { id: string; count: number } | null = null;
  for (const category of preview.categories) {
    if (!category.enabled) continue;
    const count = candidatesIn(preview, category.id).length;
    if (count > 0 && (best === null || count > best.count))
      best = { id: category.id, count };
  }
  return best?.id ?? null;
}

/* -------------------------------------------------------------------------- */

/** One module worth a first bounty, and what makes it so. */
export interface FitModule {
  readonly path: string;
  readonly files: number;
  readonly testFiles: number;
  /** Short reasons, most telling first: "own tests", "small". */
  readonly reasons: readonly string[];
}

/**
 * Directories that are not product code, whatever they hold: a bounty is not
 * cut from the docs or the CI config.
 */
const NOT_CODE =
  /(^|\/)(docs?|documentation|examples?|samples?|\.github|\.circleci|scripts|tooling|infra|terraform|deploy|ops|fixtures?|vendor|third[-_]party)$/i;

/** Fewer files than this is a stub, not somewhere work happens. */
const MIN_FILES = 3;
/** More than this is too much code for a contributor to hold. */
const MAX_FILES = 400;

/**
 * The modules a first bounty is easiest to cut from, best first, at most
 * `limit`.
 *
 * A sandbox is a slice of the repository that has to build and be checked
 * on its own, so the best places are modules that already carry tests (the
 * checks exist and the code was written to be tested) and that are small
 * enough to slice without dragging half the repository along. Ranked by
 * whether a module has tests, then by how much of it is tests, then smaller
 * first. The root is never offered: it is whatever did not fit a module.
 */
export function fitModules(facts: TreeFactsDto, limit = 4): FitModule[] {
  return facts.modules
    .filter(
      (module) =>
        module.path !== "." &&
        !NOT_CODE.test(module.path) &&
        module.files >= MIN_FILES &&
        module.files <= MAX_FILES,
    )
    .map((module) => ({
      module,
      tested: module.testFiles > 0 ? 1 : 0,
      ratio: module.testFiles / module.files,
    }))
    .sort(
      (a, b) =>
        b.tested - a.tested ||
        b.ratio - a.ratio ||
        a.module.files - b.module.files ||
        a.module.path.localeCompare(b.module.path),
    )
    .slice(0, limit)
    .map(({ module }) => ({
      path: module.path,
      files: module.files,
      testFiles: module.testFiles,
      reasons: [
        module.testFiles > 0 ? "has its own tests" : "no tests yet",
        module.files <= 60 ? "small" : "contained",
      ],
    }));
}

/** The share of a repository's files that are tests, as a whole percent. */
export function testShare(facts: TreeFactsDto): number {
  return facts.fileCount === 0
    ? 0
    : Math.round((facts.testFiles / facts.fileCount) * 100);
}
