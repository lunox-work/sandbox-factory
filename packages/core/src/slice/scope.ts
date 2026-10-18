/**
 * What the scope agent proposes for a bounty.
 *
 * A proposal is a slice request (entry points, budget, inferred edges),
 * why each entry point is there, which of the cut modules are input/output
 * seams that are safe to mock, and the deterministic result of slicing
 * exactly that request. The model chooses; the slice computation decides
 * what the choice means, and a person approves one wider than
 * `AUTO_SLICE_LIMITS` before it is cut into a sandbox. Pure shapes and
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
 * Code already in the repository that does what the bounty asks somewhere
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
 * The widest slice the sizing cuts from the scope agent's request without a
 * person's approval. The agent reads repository text, which can steer it,
 * so a wider request waits for an owner or admin to approve exactly what it
 * holds. The bounds are the slice budget's defaults, which the tickets
 * sized so far fit: 3 to 14 files a few imports deep.
 */
export const AUTO_SLICE_LIMITS = { includedFiles: 40, maxDepth: 3 } as const;
/** Why a slice waits for approval. */
export const SLICE_APPROVAL_REASONS = [
  /** An entry point names a directory (or anything but a file it includes). */
  "directory_entry_point",
  "too_many_files",
  "too_deep",
] as const;
export type SliceApprovalReason = (typeof SLICE_APPROVAL_REASONS)[number];

/**
 * Why a slice the profiler cut needs a person's approval, from the request
 * it ran and what it included; empty when it is within `AUTO_SLICE_LIMITS`.
 * An entry point counts as a file only when the slice included it by that
 * path, so a directory, or a path it did not list, needs approval. Only a
 * complete list can tell: one the summary cut short (`included` shorter
 * than `includedFiles`) is not checked, and is past the file limit anyway.
 */
export function sliceApprovalReasons(
  request: {
    readonly entryPoints: readonly string[];
    readonly budget: SliceBudget;
  },
  slice: {
    readonly includedFiles: number;
    readonly included: readonly string[];
  },
): SliceApprovalReason[] {
  const included = new Set(slice.included);
  const reasons: SliceApprovalReason[] = [];
  if (
    slice.included.length >= slice.includedFiles &&
    request.entryPoints.some((entry) => !included.has(entry))
  )
    reasons.push("directory_entry_point");
  if (slice.includedFiles > AUTO_SLICE_LIMITS.includedFiles)
    reasons.push("too_many_files");
  if (request.budget.maxDepth > AUTO_SLICE_LIMITS.maxDepth)
    reasons.push("too_deep");
  return reasons;
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
