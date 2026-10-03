/**
 * What the scope agent proposes for a ticket.
 *
 * A proposal is the slice request a person reviews in the picker (entry
 * points, budget, inferred edges), why each entry point is there, which of
 * the cut modules are input/output seams that are safe to mock, and the
 * deterministic result of slicing exactly that request. The model chooses;
 * the slice computation decides what the choice means. Pure shapes and
 * rules: the agent loop and the slice computation live in the worker.
 */

import type { AgentUsage, SliceBudget } from "../analysis.js";
import type { StubCoverage } from "./manifest.js";

export const SCOPE_PROPOSAL_SCHEMA_VERSION = 1;

/** What sits behind a cut the agent calls a seam. */
export const SEAM_KINDS = [
  "database",
  "network",
  "sdk",
  "filesystem",
  "queue",
  "clock",
  "config",
  "other",
] as const;
export type SeamKind = (typeof SEAM_KINDS)[number];

export const SCOPE_LIMITS = {
  reasonChars: 500,
  summaryChars: 2_000,
  risks: 10,
  seams: 50,
} as const;

export interface ScopeEntryPoint {
  readonly path: string;
  readonly reason: string;
}
/**
 * Code already in the repository that does what the ticket asks somewhere
 * else, so the change can follow it rather than invent one.
 */
export interface ScopePattern {
  /** A repository file path, checked to exist. */
  readonly path: string;
  readonly reason: string;
}
export interface ScopeSeam {
  /** A cut module's repository path. */
  readonly module: string;
  readonly kind: SeamKind;
  readonly reason: string;
}
/** The agent's answer, before the worker checks and records it. */
export interface ScopeSubmission {
  readonly entryPoints: readonly ScopeEntryPoint[];
  readonly budget: SliceBudget;
  readonly includeInferred: boolean;
  readonly seams: readonly ScopeSeam[];
  /** What the freelancer will see and do, in a few sentences. */
  readonly summary: string;
  readonly risks: readonly string[];
  /**
   * The closest existing pattern to follow, or null when there is none.
   * Absent on proposals from before `scope@2`.
   */
  readonly pattern?: ScopePattern | null;
}
/** The slice computation's verdict on exactly the submitted request. */
export interface ScopeCheck {
  readonly stubCoverage: StubCoverage;
  readonly ready: boolean;
  readonly includedFiles: number;
  readonly outboundModules: number;
  readonly blockers: number;
}
/** `scope-proposal.json`. */
export interface ScopeProposal extends ScopeSubmission {
  readonly schemaVersion: typeof SCOPE_PROPOSAL_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly sourceSnapshotId: string;
  readonly sourceCommitSha: string;
  readonly graphRunId: string;
  readonly proposalId: string;
  readonly specRevision: number;
  readonly check: ScopeCheck;
  readonly usage: AgentUsage;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The slice request a proposal stands for, canonical as the slice route stores it. */
export function sliceRequestOf(submission: ScopeSubmission): {
  entryPoints: string[];
  budget: SliceBudget;
  includeInferred: boolean;
} {
  return {
    entryPoints: [
      ...new Set(submission.entryPoints.map((entry) => entry.path)),
    ].sort(compare),
    budget: submission.budget,
    includeInferred: submission.includeInferred,
  };
}

/**
 * Why a submission cannot be recorded: an entry point named twice, or a
 * seam that is not one of the modules slicing the request actually cut.
 */
export function scopeProblems(
  submission: ScopeSubmission,
  cutModules: readonly string[],
): string[] {
  const problems: string[] = [];
  const paths = submission.entryPoints.map((entry) => entry.path);
  for (const [index, path] of paths.entries())
    if (paths.indexOf(path) !== index)
      problems.push(`${path} is listed as an entry point twice.`);
  const cut = new Set(cutModules);
  const seams = new Set<string>();
  for (const seam of submission.seams) {
    if (!cut.has(seam.module))
      problems.push(
        `${seam.module} is not a module this request cuts, so it cannot be a seam.`,
      );
    if (seams.has(seam.module))
      problems.push(`${seam.module} is listed as a seam twice.`);
    seams.add(seam.module);
  }
  return problems;
}
