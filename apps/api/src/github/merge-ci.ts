/**
 * Following a merge-back's pull request once it is open: its head commit's
 * CI, whether it was merged or closed, and, for one opened to merge when
 * CI passes, the merge itself.
 *
 * A read (`refresh`) asks GitHub for the pull request, then its head's
 * check runs and commit statuses (`summarizeCi`), and records them on the
 * `submission_merge` row. Two things ask for one: a GitHub delivery about
 * the repository (`check_suite`, `check_run`, `status`, `pull_request`;
 * `webhook.ts` matches it to rows by branch, head or number, then reads
 * after the answer) and the reconcile sweep (`sweep`, every five minutes
 * from `reconcile.ts`), which re-reads every followed row not read in the
 * last few minutes, so a lost delivery costs minutes, not the merge.
 *
 * What it never does: merge on CI that is failing, pending, `none` or
 * `unknown` (the App holds no `checks`/`statuses` read), merge a head it
 * did not read CI on (the merge names the sha), or retry a merge GitHub
 * refused in any way but the next read: a refusal (branch protection, a
 * review required) is recorded on the row and the pull request stays open
 * until a later read finds GitHub willing.
 *
 * Every state change is a workspace webhook event: `submission.ci` once per
 * head and state, `submission.merged` once (only the process whose write
 * found the pull request still open reports it).
 */

import type {
  MergeCiState,
  StoredSubmissionMerge,
  SubmissionMergeStore,
  SubmissionStore,
} from "@sandbox-factory/db";
import {
  GithubAuthError,
  type PullRequestRead,
  summarizeCi,
} from "@sandbox-factory/github";
import type {
  SubmissionEventData,
  SubmissionEventType,
} from "@sandbox-factory/shared";

import type { MergeBackTarget, MergeBackTargets } from "./merge-back.js";

/** How long no checks at all still reads `pending` after the pull request opened. */
export const CI_GRACE_MS = 10 * 60_000;
/** A row read more recently than this is left for the next sweep. */
export const CI_RECHECK_MS = 4 * 60_000;
/** How long after opening an open pull request is still swept; deliveries go on. */
export const CI_FOLLOW_MS = 14 * 24 * 60 * 60_000;
/** The most rows one sweep reads. */
const CI_BATCH = 50;

/** Owes a workspace webhook event; never throws (`WebhookEmitter.emit`). */
export type SubmissionEventEmit = <T extends SubmissionEventType>(
  organizationId: string,
  type: T,
  key: string,
  data: SubmissionEventData<T>,
) => void;

export interface MergeCiTrackerOptions {
  readonly merges: Pick<
    SubmissionMergeStore,
    "get" | "openForRepo" | "dueForCi" | "recordCi" | "recordPullRequest"
  >;
  readonly targets: MergeBackTargets;
  /** The submission's version, which every event names. */
  readonly submissions: Pick<SubmissionStore, "get">;
  readonly emit?: SubmissionEventEmit | undefined;
  readonly now?: (() => Date) | undefined;
  /** A failure worth a log line: the error's name and message only. */
  readonly onError?: ((code: string, detail?: string) => void) | undefined;
}

/** What a delivery names, any of which picks a followed row. */
export interface CiSignal {
  readonly branches?: readonly string[];
  readonly shas?: readonly string[];
  readonly pullNumbers?: readonly number[];
}

/** What one read did; for tests and logs. */
export type RefreshOutcome =
  "untracked" | "unavailable" | "read" | "merged" | "closed" | "merge-refused";

const MERGE_FORBIDDEN =
  "The GitHub App may not merge on this repository. Accept its contents: write permission on the installation.";
const NOT_MERGEABLE =
  "GitHub says the pull request does not merge cleanly onto its base. Resolve the conflict on GitHub; it merges on the next passing read.";

export class MergeCiTracker {
  readonly #options: MergeCiTrackerOptions;

  constructor(options: MergeCiTrackerOptions) {
    this.#options = options;
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  /** The repository's followed submissions a delivery's signal names. */
  async matching(
    organizationId: string,
    repoId: string,
    signal: CiSignal,
  ): Promise<string[]> {
    const open = await this.#options.merges.openForRepo(organizationId, repoId);
    return open
      .filter(
        (merge) =>
          (signal.branches ?? []).includes(merge.branch) ||
          (merge.ciHeadSha !== null &&
            (signal.shas ?? []).includes(merge.ciHeadSha)) ||
          (signal.pullNumbers ?? []).includes(merge.pullRequestNumber),
      )
      .map((merge) => merge.submissionId);
  }

  /** `refresh` for each, a failure reported rather than thrown. */
  async refreshAll(
    organizationId: string,
    submissionIds: readonly string[],
  ): Promise<void> {
    for (const submissionId of submissionIds) {
      try {
        await this.refresh(organizationId, submissionId);
      } catch (error) {
        this.#report("merge_ci_refresh_failed", error);
      }
    }
  }

  /** Re-reads the followed rows not read lately; see the file comment. */
  async sweep(): Promise<{ read: number; failed: number }> {
    const now = this.#now();
    const due = await this.#options.merges.dueForCi(
      new Date(now.getTime() - CI_RECHECK_MS),
      new Date(now.getTime() - CI_FOLLOW_MS),
      CI_BATCH,
    );
    let read = 0;
    let failed = 0;
    for (const { organizationId, merge } of due) {
      try {
        await this.#refreshRow(organizationId, merge);
        read += 1;
      } catch (error) {
        failed += 1;
        this.#report("merge_ci_refresh_failed", error);
        // Stamped, so one that keeps failing does not hold the queue's head.
        await this.#options.merges
          .recordCi(organizationId, merge.submissionId, {
            ciState: merge.ciState,
            ciSummary: merge.ciSummary,
            ciHeadSha: merge.ciHeadSha,
            ciCheckedAt: now,
          })
          .catch(() => undefined);
      }
    }
    return { read, failed };
  }

  /** Reads one submission's pull request and its CI; see the file comment. */
  async refresh(
    organizationId: string,
    submissionId: string,
  ): Promise<RefreshOutcome> {
    const merge = await this.#options.merges.get(organizationId, submissionId);
    if (merge === null) return "untracked";
    return this.#refreshRow(organizationId, merge);
  }

  async #refreshRow(
    organizationId: string,
    merge: StoredSubmissionMerge,
  ): Promise<RefreshOutcome> {
    if (merge.pullRequestState !== "open" || merge.repoId === null)
      return "untracked";
    const { merges } = this.#options;
    const now = this.#now();
    const target = await this.#options.targets.target(
      organizationId,
      merge.repoId,
    );
    if (target === null) {
      // The repository or its installation is gone: nothing to read now.
      await merges.recordCi(organizationId, merge.submissionId, {
        ciState: merge.ciState,
        ciSummary: merge.ciSummary,
        ciHeadSha: merge.ciHeadSha,
        ciCheckedAt: now,
      });
      return "unavailable";
    }
    const pull = await target.writer.getPullRequest(
      target.fullName,
      merge.pullRequestNumber,
    );
    if (pull.merged || pull.state === "closed")
      return this.#ended(organizationId, merge, pull, "github", now);

    const read = await this.#readCi(target, pull, merge, now);
    const recorded = await merges.recordCi(organizationId, merge.submissionId, {
      ciState: read.state,
      ciSummary: read.summary,
      ciHeadSha: pull.headSha,
      ciCheckedAt: now,
    });
    if (recorded === null) return "untracked";
    if (read.state !== merge.ciState || pull.headSha !== merge.ciHeadSha)
      await this.#emit(organizationId, merge, "submission.ci", {
        key: `${merge.submissionId}:${pull.headSha}:${read.state}`,
        data: {
          state: read.state,
          headSha: pull.headSha,
          total: read.summary?.total ?? 0,
          passed: read.summary?.passed ?? 0,
          failed: read.summary?.failed ?? 0,
          pending: read.summary?.pending ?? 0,
        },
      });
    if (merge.mergeWhen !== "ci_passes" || read.state !== "passing")
      return "read";

    let refusal: string;
    if (pull.mergeable === false) refusal = NOT_MERGEABLE;
    else {
      try {
        const outcome = await target.writer.merge(
          target.fullName,
          merge.pullRequestNumber,
          { sha: pull.headSha, title: pull.title },
        );
        if (outcome.merged)
          return this.#ended(
            organizationId,
            merge,
            { ...pull, merged: true, mergeCommitSha: outcome.sha },
            "platform",
            now,
          );
        refusal = outcome.reason;
      } catch (error) {
        if (!(error instanceof GithubAuthError)) throw error;
        refusal = MERGE_FORBIDDEN;
      }
    }
    await merges.recordCi(organizationId, merge.submissionId, {
      ciState: read.state,
      ciSummary: read.summary,
      ciHeadSha: pull.headSha,
      ciCheckedAt: now,
      mergeError: refusal,
    });
    return "merge-refused";
  }

  /** The head's CI: `unknown` without the permissions to read it. */
  async #readCi(
    target: MergeBackTarget,
    pull: PullRequestRead,
    merge: StoredSubmissionMerge,
    now: Date,
  ): Promise<{
    state: MergeCiState;
    summary: StoredSubmissionMerge["ciSummary"];
  }> {
    if (target.ciReader === null) return { state: "unknown", summary: null };
    let checkRuns;
    let statuses;
    try {
      checkRuns = await target.ciReader.checkRuns(
        target.fullName,
        pull.headSha,
      );
      statuses = await target.ciReader.statuses(target.fullName, pull.headSha);
    } catch (error) {
      // Accepted once and revoked since, before the stored copy knew.
      if (error instanceof GithubAuthError)
        return { state: "unknown", summary: null };
      throw error;
    }
    const { state, ...summary } = summarizeCi(checkRuns, statuses, {
      graceOver:
        now.getTime() - new Date(merge.createdAt).getTime() >= CI_GRACE_MS,
    });
    return { state, summary: { ...summary, failing: [...summary.failing] } };
  }

  async #ended(
    organizationId: string,
    merge: StoredSubmissionMerge,
    pull: PullRequestRead,
    by: "platform" | "github",
    now: Date,
  ): Promise<RefreshOutcome> {
    const recorded = await this.#options.merges.recordPullRequest(
      organizationId,
      merge.submissionId,
      {
        pullRequestState: pull.merged ? "merged" : "closed",
        mergedCommitSha: pull.merged ? pull.mergeCommitSha : null,
        mergedAt: pull.merged ? now : null,
        checkedAt: now,
      },
    );
    if (recorded !== null && pull.merged)
      await this.#emit(organizationId, merge, "submission.merged", {
        key: `${merge.submissionId}:merged`,
        data: { mergedCommitSha: pull.mergeCommitSha, by },
      });
    return pull.merged ? "merged" : "closed";
  }

  async #emit<T extends "submission.ci" | "submission.merged">(
    organizationId: string,
    merge: StoredSubmissionMerge,
    type: T,
    event: {
      readonly key: string;
      readonly data: Omit<
        SubmissionEventData<T>,
        | "submissionId"
        | "sandboxVersionId"
        | "pullRequestNumber"
        | "pullRequestUrl"
      >;
    },
  ): Promise<void> {
    const emit = this.#options.emit;
    if (emit === undefined) return;
    const submission = await this.#options.submissions.get(
      organizationId,
      merge.submissionId,
    );
    if (submission === null) return;
    emit(organizationId, type, event.key, {
      submissionId: merge.submissionId,
      sandboxVersionId: submission.sandboxVersionId,
      pullRequestNumber: merge.pullRequestNumber,
      pullRequestUrl: merge.pullRequestUrl,
      ...event.data,
    } as SubmissionEventData<T>);
  }

  #report(code: string, error: unknown): void {
    this.#options.onError?.(
      code,
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
  }
}
