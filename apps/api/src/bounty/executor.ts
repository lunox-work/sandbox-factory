import { randomUUID } from "node:crypto";

import type {
  BountyProposalStore,
  BountyRunStore,
  JiraBoardStore,
  JiraIssueStore,
  StoredBountyRun,
} from "@sandbox-factory/db";
import {
  JiraApiError,
  JiraAuthError,
  type JiraIssueSpec,
} from "@sandbox-factory/jira";
import type { JiraIssueDto } from "@sandbox-factory/shared";
import {
  priceFor,
  type BountyRunOutcome,
  type BountySizingResult,
} from "sandbox-factory";

import type { Sizer } from "../sizing/sizer.js";
import { SizerError } from "../sizing/sizer.js";
import { selectBacklog, type BacklogPageReader } from "./selection.js";

const HEARTBEAT_MS = 15_000;
const CONCURRENCY = 3;

export interface RunJiraClient extends BacklogPageReader {
  issueSpec(issueId: string): Promise<JiraIssueSpec>;
  /** One ticket's list fields, for an `issue` run's single ticket. */
  issue(issueId: string): Promise<JiraIssueDto>;
}

export type RunClientResult =
  | { readonly ok: true; readonly client: RunJiraClient }
  | { readonly ok: false; readonly reason: "not-found" | "reconnect" };

export interface BountyExecutorOptions {
  readonly boards: JiraBoardStore;
  readonly runs: BountyRunStore;
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  readonly sizer: Sizer;
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly now?: () => Date;
  readonly leaseToken?: () => string;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onWritebackCreated?: (
    organizationId: string,
    operationId: string,
  ) => void;
  /**
   * Called when `execute` itself throws. `code` is fixed; `error` is the
   * thrown value, for the operator's log — it is never sent to a client.
   */
  readonly onBackgroundError?: (code: string, error?: unknown) => void;
}

export class BountyExecutor {
  readonly #options: BountyExecutorOptions;

  constructor(options: BountyExecutorOptions) {
    this.#options = options;
  }

  /** Starts after the queued row commits; failures are observed as fixed codes. */
  start(organizationId: string, runId: string): void {
    void this.execute(organizationId, runId).catch((error: unknown) => {
      this.#options.onBackgroundError?.("bounty_executor_failed", error);
    });
  }

  async execute(organizationId: string, runId: string): Promise<void> {
    const { runs, boards, proposals } = this.#options;
    const now = this.#options.now ?? (() => new Date());
    const leaseToken = (this.#options.leaseToken ?? randomUUID)();
    const queued = await runs.get(organizationId, runId);
    if (queued === null || queued.status !== "queued") return;
    const run = await runs.claim(organizationId, runId, leaseToken, now());
    if (run === null) return;

    const controller = new AbortController();
    const heartbeat = (this.#options.setInterval ?? setInterval)(() => {
      void runs
        .heartbeat(organizationId, runId, leaseToken, now())
        .then((held) => {
          if (!held) controller.abort();
        })
        .catch(() => controller.abort());
    }, HEARTBEAT_MS);

    try {
      const registered = await boards.forRun(organizationId, run.boardId);
      if (registered === null) {
        await runs.finish(organizationId, runId, leaseToken, "failed", {
          fatalErrorCode: "board_unavailable",
        });
        return;
      }
      const clientResult = await this.#options.clientFor(
        organizationId,
        registered.connectionId,
      );
      if (!clientResult.ok) {
        await runs.finish(organizationId, runId, leaseToken, "failed", {
          fatalErrorCode: clientResult.reason,
        });
        return;
      }

      let selected: {
        issues: JiraIssueDto[];
        candidatesScanned: number;
        skippedLive: number;
        scanLimitReached: boolean;
      };
      try {
        if (run.kind === "reprice") {
          const source =
            run.sourceProposalId === null
              ? null
              : await proposals.get(organizationId, run.sourceProposalId);
          const pointer =
            source === null
              ? null
              : await this.#options.issues.get(
                  organizationId,
                  source.jiraIssueId,
                );
          if (
            source === null ||
            pointer === null ||
            source.revision !== run.sourceRevision
          ) {
            await runs.finish(organizationId, runId, leaseToken, "failed", {
              fatalErrorCode: "proposal_changed",
            });
            return;
          }
          selected = {
            issues: [
              {
                id: pointer.externalId,
                key: pointer.key,
                summary: "",
                status: "",
                statusCategory: statusCategory(pointer.statusCategory),
                assignee: null,
                priority: null,
                issueType: "",
                labels: [],
                projectKey: null,
                parentKey: null,
                created: pointer.remoteCreatedAt,
                updated: pointer.remoteUpdatedAt,
                dueDate: null,
                url: null,
              },
            ],
            candidatesScanned: 1,
            skippedLive: 0,
            scanLimitReached: false,
          };
        } else if (run.kind === "issue") {
          /*
            One ticket someone picked, named in the plan when the run was
            created. Read again here rather than trusted from the plan: its
            dates and status are what the pointer records, and the ticket
            may have moved or gone since it was picked.
          */
          const target = run.planned[0];
          if (target === undefined) {
            await runs.finish(organizationId, runId, leaseToken, "failed", {
              fatalErrorCode: "issue_unavailable",
            });
            return;
          }
          selected = {
            issues: [await clientResult.client.issue(target.externalIssueId)],
            candidatesScanned: 1,
            skippedLive: 0,
            scanLimitReached: false,
          };
        } else {
          selected = await selectBacklog({
            organizationId,
            board: registered.board,
            client: clientResult.client,
            proposals,
            now: now(),
          });
        }
      } catch (error) {
        await runs.finish(organizationId, runId, leaseToken, "failed", {
          fatalErrorCode: jiraCode(error),
        });
        return;
      }

      /*
        What the run is about to size, before the first ticket is sent to
        the model. A page opened mid-run lists it with each ticket's state,
        so what is still to come shows as well as what is done.
      */
      const planned = await runs.recordPlan(
        organizationId,
        runId,
        leaseToken,
        selected.issues.map((issue) => ({
          externalIssueId: issue.id,
          issueKey: issue.key,
          summary: issue.summary,
        })),
      );
      if (!planned) return;

      const outcomes: BountyRunOutcome[] = [];
      let nextIndex = 0;
      let fatalCode: string | undefined;

      const worker = async () => {
        while (
          fatalCode === undefined &&
          !controller.signal.aborted &&
          nextIndex < selected.issues.length
        ) {
          const candidate = selected.issues[nextIndex];
          nextIndex += 1;
          if (candidate === undefined) return;
          const outcome = await this.#processIssue(
            organizationId,
            run,
            leaseToken,
            candidate,
            clientResult.client,
            controller.signal,
          );
          if (outcome.fatalCode !== undefined) {
            // The first fatal code is the cause. Aborting the controller
            // cancels the other workers mid-request, and their resulting
            // `worker_lost` must not overwrite it.
            fatalCode ??= outcome.fatalCode;
            controller.abort();
          }
          if (outcome.value !== undefined) {
            outcomes.push(outcome.value);
            const recorded = await runs.recordOutcome(
              organizationId,
              runId,
              leaseToken,
              outcome.value,
            );
            if (!recorded) {
              fatalCode = "worker_lost";
              controller.abort();
            }
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, selected.issues.length) },
          () => worker(),
        ),
      );

      const succeeded = outcomes.filter(
        ({ status }) => status !== "failed",
      ).length;
      const failed = outcomes.filter(
        ({ status }) => status === "failed",
      ).length;
      const status =
        fatalCode !== undefined || (failed > 0 && succeeded === 0)
          ? "failed"
          : failed > 0
            ? "partial"
            : "succeeded";
      await runs.finish(organizationId, runId, leaseToken, status, {
        ...(fatalCode === undefined ? {} : { fatalErrorCode: fatalCode }),
        candidatesScanned: selected.candidatesScanned,
        skippedLive: selected.skippedLive,
        scanLimitReached: selected.scanLimitReached,
      });
    } finally {
      (this.#options.clearInterval ?? clearInterval)(heartbeat);
    }
  }

  async #processIssue(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    candidate: Awaited<ReturnType<typeof selectBacklog>>["issues"][number],
    client: RunJiraClient,
    signal: AbortSignal,
  ): Promise<{ value?: BountyRunOutcome; fatalCode?: string }> {
    const base = {
      externalIssueId: candidate.id,
      issueKey: candidate.key,
    };
    if (!validDate(candidate.created) || !validDate(candidate.updated)) {
      return {
        value: { ...base, status: "failed", code: "invalid_issue_dates" },
      };
    }

    const pointer = await this.#options.issues.upsert(
      organizationId,
      run.boardId,
      {
        externalId: candidate.id,
        key: candidate.key,
        statusCategory: candidate.statusCategory,
        remoteCreatedAt: candidate.created,
        remoteUpdatedAt: candidate.updated,
      },
    );
    if (pointer === null) {
      return { value: { ...base, status: "failed", code: "issue_pointer" } };
    }

    let spec: JiraIssueSpec;
    try {
      spec = await client.issueSpec(candidate.id);
    } catch (error) {
      if (error instanceof JiraApiError && error.isNotFound) {
        await this.#options.issues.markRemoved(organizationId, pointer.id);
        return {
          value: {
            ...base,
            jiraIssueId: pointer.id,
            status: "failed",
            code: "issue_unavailable",
          },
        };
      }
      const code = jiraCode(error);
      return code === "reconnect" || code === "scope"
        ? { fatalCode: code }
        : {
            value: {
              ...base,
              jiraIssueId: pointer.id,
              status: "failed",
              code,
            },
          };
    }

    let sizing: BountySizingResult;
    let actualModel = run.requestedModel;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let technicalFailure = false;
    if (spec.inputTruncated) {
      sizing = fixedUnsized(
        "spec_too_large",
        "The ticket is too large to size safely.",
      );
    } else if (
      spec.summary.length + spec.descriptionText.length <
      run.selection.minSpecChars
    ) {
      sizing = fixedUnsized(
        "insufficient_spec",
        "The ticket does not contain enough detail to size.",
      );
    } else {
      try {
        const sized = await this.#options.sizer.size(
          {
            summary: spec.summary,
            descriptionText: spec.descriptionText,
            issueType: spec.issueType,
          },
          {
            signal,
            ...(run.deadlineAt === null
              ? {}
              : { deadlineAt: new Date(run.deadlineAt) }),
          },
        );
        sizing = sized.result;
        actualModel = sized.actualModel;
        inputTokens = sized.usage.inputTokens;
        outputTokens = sized.usage.outputTokens;
      } catch (error) {
        if (error instanceof SizerError && error.stopsRun) {
          return { fatalCode: error.code };
        }
        if (error instanceof SizerError && error.code === "sizing_cancelled") {
          return { fatalCode: "worker_lost" };
        }
        technicalFailure = true;
        sizing = fixedUnsized(
          "sizing_failed",
          "Sizing could not be completed for this ticket.",
        );
      }
    }

    if (technicalFailure && run.kind === "reprice") {
      return {
        value: {
          ...base,
          jiraIssueId: pointer.id,
          status: "failed",
          code: "sizing_failed",
        },
      };
    }

    const amountMinor = priceFor(sizing.complexity, run.rateCard);
    const input = {
      runId: run.id,
      jiraIssueId: pointer.id,
      specHash: spec.pricingSpecHash,
      specHashVersion: 1,
      rateCard: run.rateCard,
      sizing,
      inputTruncated: spec.inputTruncated,
      actualModel,
      promptVersion: run.promptVersion,
      amountMinor,
      currency: amountMinor === null ? null : run.rateCard.currency,
    };
    const created =
      run.kind === "reprice" &&
      run.sourceProposalId !== null &&
      run.sourceRevision !== null
        ? await this.#options.proposals.repriceForLease(
            organizationId,
            leaseToken,
            run.sourceProposalId,
            run.sourceRevision,
            input,
          )
        : await this.#options.proposals.createForLease(
            organizationId,
            leaseToken,
            input,
          );
    if (created.status === "lost-lease") return { fatalCode: "worker_lost" };
    if (created.status !== "created" && created.status !== "repriced") {
      return {
        value: {
          ...base,
          jiraIssueId: pointer.id,
          status: "skipped",
          code:
            created.status === "duplicate"
              ? "live_proposal"
              : created.status === "changed"
                ? "proposal_changed"
                : created.status === "writeback-busy"
                  ? "writeback_busy"
                  : "not_found",
        },
      };
    }
    const writebackOperationId =
      "writebackOperationId" in created
        ? created.writebackOperationId
        : undefined;
    if (typeof writebackOperationId === "string") {
      this.#options.onWritebackCreated?.(organizationId, writebackOperationId);
    }

    return {
      value: {
        ...base,
        jiraIssueId: pointer.id,
        proposalId: created.proposal.id,
        status: technicalFailure
          ? "failed"
          : sizing.complexity === "unsized"
            ? "unsized"
            : "proposed",
        ...(technicalFailure ? { code: "sizing_failed" } : {}),
        actualModel,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      },
    };
  }
}

function fixedUnsized(reason: string, rationale: string): BountySizingResult {
  return {
    complexity: "unsized",
    confidence: "low",
    rationale,
    unsizedReason: reason,
  };
}

function validDate(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function statusCategory(
  value: string,
): "new" | "indeterminate" | "done" | "unknown" {
  return value === "new" || value === "indeterminate" || value === "done"
    ? value
    : "unknown";
}

function jiraCode(error: unknown): string {
  if (error instanceof JiraAuthError && error.needsReconnect)
    return "reconnect";
  if (error instanceof JiraApiError) {
    if (error.isUnauthorized) return "reconnect";
    if (error.isForbidden) return "scope";
    if (error.isRateLimited) return "jira_rate_limited";
    return "jira_failed";
  }
  return "jira_failed";
}
