import { randomUUID } from "node:crypto";

import type {
  BountyProposalStore,
  BountyRunStore,
  BountySpecStore,
  JiraBoardStore,
  JiraIssueStore,
  NewBountySpec,
  StoredBountyProposal,
  StoredBountyRun,
  JiraIssuePointer,
} from "@sandbox-factory/db";
import {
  JiraApiError,
  JiraAuthError,
  type JiraIssueSpec,
} from "@sandbox-factory/jira";
import {
  boardPricingSchema,
  specDraftSchema,
  type JiraIssueDto,
  type JiraIssuePageDto,
} from "@sandbox-factory/shared";
import {
  answerSpec,
  checkRespec,
  describeRespec,
  expandSpec,
  pointsDelta,
  priceFor,
  resolveStepSettings,
  sameSpec,
  stepUp,
  trimSpec,
  type BountyRunOutcome,
  type BountySizingResult,
  type CategoryMatch,
  type RespecRequest,
  type SpecDraft,
  type StepResult,
  type StepSettings,
} from "sandbox-factory";

import {
  SizerError,
  type SizingRequestOptions,
  type SizingUsage,
  type StructuredCaller,
} from "../sizing/caller.js";
import { draftSpecTool } from "../sizing/tools/draft-spec.js";
import {
  answerSpecTool,
  expandSpecTool,
  REVISE_SPEC_PROMPT_VERSION,
} from "../sizing/tools/revise-spec.js";
import { sizeBountyTool } from "../sizing/tools/size-bounty.js";
import { selectBacklog, type BacklogPageReader } from "./selection.js";

const HEARTBEAT_MS = 15_000;
const CONCURRENCY = 3;

/**
 * A ticket a run is about to size. A backlog run knows why it picked each
 * one; a ticket a person picked, or one being re-priced, has no such reason.
 */
type RunCandidate = JiraIssueDto & {
  readonly categories?: readonly CategoryMatch[];
};

export interface RunJiraClient extends BacklogPageReader {
  /** A board's tickets, for finding one by id or by what a person typed. */
  boardIssues(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssuePageDto>;
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
  /** The spec revisions a `respec` run changes. */
  readonly specs: BountySpecStore;
  /** The model behind every call a run makes: the spec draft and the size. */
  readonly caller: StructuredCaller;
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  /**
   * The outline of a board's source repository, from its current snapshot,
   * or null when it has none yet. Absent, no draft is shown one.
   */
  readonly outlineFor?: (
    organizationId: string,
    repoId: string,
  ) => Promise<RepositoryOutlineRead | null>;
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

/** An outline to draft beside, and the snapshot it was drawn from. */
export interface RepositoryOutlineRead {
  readonly snapshotId: string;
  readonly text: string;
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

      if (run.kind === "respec") {
        await this.#respec(
          organizationId,
          run,
          leaseToken,
          clientResult.client,
          controller.signal,
        );
        return;
      }

      let selected: {
        issues: RunCandidate[];
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
          /*
            Why the ticket was picked, carried over from the plan its
            proposal came from. A re-price moves the proposal onto this run,
            and a proposal's reasons are read from its run's plan: without
            this, asking the model to look again would quietly take the
            ticket out of its category.
          */
          const origin = await runs.get(organizationId, source.runId);
          const categories =
            origin?.planned.find(
              (planned) => planned.externalIssueId === pointer.externalId,
            )?.categories ?? [];
          selected = {
            issues: [
              {
                categories,
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
          const picked = await clientResult.client.issue(
            target.externalIssueId,
          );
          // Split into sub-tasks since it was picked: priced through them,
          // as a backlog run would, never itself.
          if ((picked.subtaskCount ?? 0) > 0) {
            await runs.finish(organizationId, runId, leaseToken, "failed", {
              fatalErrorCode: "issue_has_subtasks",
            });
            return;
          }
          selected = {
            issues: [picked],
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
        so what is still to come shows as well as what is done. Each ticket
        carries why it was picked, which is what a proposal later shows as
        its reason.

        Recording the plan also moves the deadline out by its size, so the
        run continues as the row the store hands back: sizing against the
        deadline it claimed with would cut a long run short.
      */
      const planned = await runs.recordPlan(
        organizationId,
        runId,
        leaseToken,
        selected.issues.map((issue) => ({
          externalIssueId: issue.id,
          issueKey: issue.key,
          summary: issue.summary,
          categories: [...(issue.categories ?? [])],
        })),
      );
      if (planned === null) return;

      /*
        How the board counts scenario weight, read once for the run. Every
        step this run writes is zero, since a fresh draft has added
        nothing, but it is written with the settings that will count what
        a reviewer adds to it.
      */
      const pricing = boardPricingSchema.safeParse(registered.board.pricing);
      const stepSettings = resolveStepSettings(
        pricing.success ? pricing.data.step : {},
      );
      /*
        The repository the board's tickets are about, read once for the
        run like the settings above: every ticket is drafted beside the
        same snapshot. One that cannot be read leaves the drafts without
        it rather than failing the run; the outline helps a weight, it is
        not what a size stands on.
      */
      const outline = await this.#outline(
        organizationId,
        registered.board.sourceRepoId,
      );

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
            planned,
            leaseToken,
            candidate,
            clientResult.client,
            controller.signal,
            stepSettings,
            outline,
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

  /** The board's repository outline, or null when there is none to read. */
  async #outline(
    organizationId: string,
    repoId: string | null,
  ): Promise<RepositoryOutlineRead | null> {
    const read = this.#options.outlineFor;
    if (repoId === null || read === undefined) return null;
    try {
      return await read(organizationId, repoId);
    } catch (error) {
      this.#options.onBackgroundError?.("bounty_outline_unavailable", error);
      return null;
    }
  }

  /**
   * A reviewer's change to one proposal's spec: the spec revised as asked,
   * then the size moved by the scenario step, from the base and with the
   * settings the proposal's step already holds. The model's size is not
   * asked for again: the base is "what the ticket asks for", and what the
   * reviewer added to the spec is the step's to count.
   *
   * One ticket, so no workers: a plan of one, its outcome, and the run's
   * end. The outcome carries the size before the change and the points it
   * moved, for the line the reviewer reads when it lands.
   */
  async #respec(
    organizationId: string,
    claimed: StoredBountyRun,
    leaseToken: string,
    client: RunJiraClient,
    signal: AbortSignal,
  ): Promise<void> {
    const { runs, proposals, issues } = this.#options;
    const source =
      claimed.sourceProposalId === null
        ? null
        : await proposals.get(organizationId, claimed.sourceProposalId);
    const pointer =
      source === null
        ? null
        : await issues.get(organizationId, source.jiraIssueId);
    if (
      claimed.respec === null ||
      pointer === null ||
      !respeccable(source, claimed)
    ) {
      await runs.finish(organizationId, claimed.id, leaseToken, "failed", {
        fatalErrorCode: "proposal_changed",
      });
      return;
    }
    const run = await runs.recordPlan(organizationId, claimed.id, leaseToken, [
      {
        externalIssueId: pointer.externalId,
        issueKey: pointer.key,
        summary: "",
      },
    ]);
    if (run === null) return;

    const outcome = await this.#respecOutcome(
      organizationId,
      run,
      leaseToken,
      source,
      pointer,
      claimed.respec,
      client,
      signal,
    );
    if (outcome.value === undefined) {
      await runs.finish(organizationId, run.id, leaseToken, "failed", {
        fatalErrorCode: outcome.fatalCode,
      });
      return;
    }
    const recorded = await runs.recordOutcome(
      organizationId,
      run.id,
      leaseToken,
      outcome.value,
    );
    await runs.finish(
      organizationId,
      run.id,
      leaseToken,
      !recorded || outcome.value.status === "failed" ? "failed" : "succeeded",
      recorded ? {} : { fatalErrorCode: "worker_lost" },
    );
  }

  async #respecOutcome(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    source: Respeccable,
    pointer: JiraIssuePointer,
    request: RespecRequest,
    client: RunJiraClient,
    signal: AbortSignal,
  ): Promise<
    | { readonly value: BountyRunOutcome; readonly fatalCode?: undefined }
    | { readonly value?: undefined; readonly fatalCode: string }
  > {
    const base = {
      externalIssueId: pointer.externalId,
      issueKey: pointer.key,
      jiraIssueId: pointer.id,
      proposalId: source.id,
    };
    const failed = (code: string) => ({
      value: { ...base, status: "failed" as const, code },
    });

    const { specs } = this.#options;
    const [current, sized] = await Promise.all([
      specs.get(organizationId, source.id, source.specRevision),
      specs.sizedRevision(organizationId, source.id, source.specRevision),
    ]);
    if (current === null || sized === null) return failed("spec_missing");
    // Checked when it was asked for, against the revision this run reads,
    // which the source revision above has already held still.
    if (checkRespec(request, current.draft) !== null) {
      return failed("respec_invalid");
    }

    let next: SpecDraft;
    let model: { actualModel: string; usage: SizingUsage } | null = null;
    if (request.mode === "trim") {
      next = trimSpec(current.draft, request.removeScenarioIds);
    } else {
      /*
        The ticket, read again: the model needs to know what the scenarios
        are about, and the read says whether the ticket still says what it
        said when the proposal was sized. A change made of a ticket that
        has moved on would grow a spec the next re-price throws away.
      */
      let ticket: JiraIssueSpec;
      try {
        ticket = await client.issueSpec(pointer.externalId);
      } catch (error) {
        if (error instanceof JiraApiError && error.isNotFound) {
          await this.#options.issues.markRemoved(organizationId, pointer.id);
          return failed("issue_unavailable");
        }
        const code = jiraCode(error);
        return code === "reconnect" || code === "scope"
          ? { fatalCode: code }
          : failed(code);
      }
      if (
        source.specHashVersion !== SPEC_HASH_VERSION ||
        ticket.pricingSpecHash !== source.specHash
      ) {
        return failed("proposal_stale");
      }
      const options: SizingRequestOptions = {
        signal,
        ...(run.deadlineAt === null
          ? {}
          : { deadlineAt: new Date(run.deadlineAt) }),
      };
      const input = {
        ticket: {
          summary: ticket.summary,
          descriptionText: ticket.descriptionText,
          issueType: ticket.issueType,
          components: ticket.components,
          labels: ticket.labels,
        },
        spec: current.draft,
      };
      try {
        if (request.mode === "expand") {
          const answer = await this.#options.caller.call(
            expandSpecTool,
            { ...input, request },
            options,
          );
          next = expandSpec(current.draft, answer.result);
          model = answer;
        } else {
          const answer = await this.#options.caller.call(
            answerSpecTool,
            { ...input, request },
            options,
          );
          next = answerSpec(
            current.draft,
            answer.result,
            request.answers.map(({ question }) => question),
          );
          model = answer;
        }
      } catch (error) {
        const fatalCode = fatalCodeOf(error);
        return fatalCode === undefined ? failed("spec_failed") : { fatalCode };
      }
    }

    const spent =
      model === null
        ? {}
        : {
            actualModel: model.actualModel,
            inputTokens: model.usage.inputTokens,
            outputTokens: model.usage.outputTokens,
          };
    // Merged here rather than written by the model, so checked again as the
    // spec a reader will be shown.
    if (!specDraftSchema.safeParse(next).success) {
      return { value: { ...failed("spec_failed").value, ...spent } };
    }
    if (sameSpec(next, current.draft)) {
      return {
        value: { ...base, status: "skipped", code: "nothing_added", ...spent },
      };
    }
    const step = stepUp(
      source.step.base,
      sized.draft,
      next,
      source.step.settings,
    );
    if (step === null) {
      return { value: { ...failed("spec_unweighed").value, ...spent } };
    }
    const amountMinor = priceFor(step.complexity, run.rateCard);
    if (amountMinor === null) return failed("spec_unweighed");

    const written = await this.#options.proposals.respecForLease(
      organizationId,
      leaseToken,
      source.id,
      source.revision,
      {
        runId: run.id,
        fromSpecRevision: source.specRevision,
        spec: {
          specHash: source.specHash,
          specHashVersion: source.specHashVersion,
          draft: next,
          origin: request.mode,
          instruction: describeRespec(request, current.draft),
          actualModel: model?.actualModel ?? null,
          promptVersion: model === null ? null : REVISE_SPEC_PROMPT_VERSION,
        },
        step,
        amountMinor,
        currency: run.rateCard.currency,
      },
    );
    if (written.status === "lost-lease") return { fatalCode: "worker_lost" };
    if (written.status !== "respecced") {
      return {
        value: {
          ...base,
          status: "skipped",
          code: written.status === "changed" ? "proposal_changed" : "not_found",
          ...spent,
        },
      };
    }
    return {
      value: {
        ...base,
        status: "proposed",
        previousComplexity: written.previousComplexity,
        pointsDelta:
          pointsDelta(current.draft, next, step.settings.weightPoints) ?? 0,
        ...spent,
      },
    };
  }

  async #processIssue(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    candidate: RunCandidate,
    client: RunJiraClient,
    signal: AbortSignal,
    stepSettings: StepSettings,
    outline: RepositoryOutlineRead | null,
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
    let drafted: NewBountySpec | undefined;
    // What each model call spent, for the calls that were made.
    const spent: SizingUsage[] = [];
    let technicalFailure = false;
    let draftFailure = false;
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
      const request: SizingRequestOptions = {
        signal,
        ...(run.deadlineAt === null
          ? {}
          : { deadlineAt: new Date(run.deadlineAt) }),
      };

      /*
        The spec first, from the same read the size is made from. Nothing
        prices from it yet, so a draft that fails costs the ticket its spec
        and not its proposal: the size is still asked for, and the outcome
        says the spec is missing. What stops a run for the size stops it
        here too, since the next call would meet the same refusal.
      */
      try {
        const draft = await this.#options.caller.call(
          draftSpecTool,
          {
            summary: spec.summary,
            descriptionText: spec.descriptionText,
            issueType: spec.issueType,
            components: spec.components,
            labels: spec.labels,
            ...(outline === null ? {} : { repositoryOutline: outline.text }),
          },
          request,
        );
        spent.push(draft.usage);
        drafted = {
          specHash: spec.pricingSpecHash,
          specHashVersion: SPEC_HASH_VERSION,
          draft: draft.result,
          origin: "draft",
          actualModel: draft.actualModel,
          promptVersion: draftSpecTool.promptVersion,
        };
      } catch (error) {
        const fatalCode = fatalCodeOf(error);
        if (fatalCode !== undefined) return { fatalCode };
        draftFailure = true;
      }

      try {
        const sized = await this.#options.caller.call(
          sizeBountyTool,
          {
            summary: spec.summary,
            descriptionText: spec.descriptionText,
            issueType: spec.issueType,
          },
          request,
        );
        sizing = sized.result;
        actualModel = sized.actualModel;
        spent.push(sized.usage);
      } catch (error) {
        const fatalCode = fatalCodeOf(error);
        if (fatalCode !== undefined) return { fatalCode };
        technicalFailure = true;
        sizing = fixedUnsized(
          "sizing_failed",
          "Sizing could not be completed for this ticket.",
        );
      }
    }

    /*
      A re-price replaces what the proposal holds, so it is all or nothing:
      a size without its spec, or no size at all, leaves the proposal as it
      was for the reviewer to try again.
    */
    if ((technicalFailure || draftFailure) && run.kind === "reprice") {
      return {
        value: {
          ...base,
          jiraIssueId: pointer.id,
          status: "failed",
          code: technicalFailure ? "sizing_failed" : "spec_failed",
        },
      };
    }

    /*
      The step, against the draft the size was made beside. Both are fresh,
      so it is always zero; it is written so a proposal has one shape to
      read, and so a later change to the spec has a step to move. None for
      an unsized ticket, which has no base, or one with no draft.
    */
    const step =
      drafted === undefined || sizing.complexity === "unsized"
        ? null
        : stepUp(sizing.complexity, drafted.draft, drafted.draft, stepSettings);
    const amountMinor = priceFor(
      step?.complexity ?? sizing.complexity,
      run.rateCard,
    );
    const input = {
      runId: run.id,
      jiraIssueId: pointer.id,
      specHash: spec.pricingSpecHash,
      specHashVersion: SPEC_HASH_VERSION,
      rateCard: run.rateCard,
      sizing,
      inputTruncated: spec.inputTruncated,
      actualModel,
      promptVersion: run.promptVersion,
      amountMinor,
      currency: amountMinor === null ? null : run.rateCard.currency,
      step,
      // What the spec was drafted beside; nothing when there is no spec.
      repoSnapshotId:
        drafted === undefined || outline === null ? null : outline.snapshotId,
      ...(drafted === undefined ? {} : { spec: drafted }),
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
        // The proposal stands either way; the code says what it lacks.
        ...(technicalFailure
          ? { code: "sizing_failed" }
          : draftFailure
            ? { code: "spec_failed" }
            : {}),
        actualModel,
        // Both calls, so a ticket's cost is what it took to propose it.
        ...(spent.length === 0
          ? {}
          : {
              inputTokens: sum(spent.map(({ inputTokens }) => inputTokens)),
              outputTokens: sum(spent.map(({ outputTokens }) => outputTokens)),
            }),
      },
    };
  }
}

/**
 * A proposal a spec change can be made to, and the step that moves its
 * size. The route checks the same before starting the run; this is the
 * proposal as the run finds it.
 */
type Respeccable = StoredBountyProposal & {
  readonly step: StepResult;
  readonly specRevision: number;
};

function respeccable(
  proposal: StoredBountyProposal | null,
  run: StoredBountyRun,
): proposal is Respeccable {
  return (
    proposal !== null &&
    proposal.revision === run.sourceRevision &&
    proposal.status === "proposed" &&
    proposal.step !== null &&
    proposal.specRevision !== null
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The version of `pricingSpecHash`: summary, description and issue type. */
const SPEC_HASH_VERSION = 1;

/**
 * The code a run ends with when a model call's failure is not the ticket's:
 * a provider that refuses every call, or a run that was cancelled under it.
 * Undefined for a failure only this ticket bears.
 */
function fatalCodeOf(error: unknown): string | undefined {
  if (!(error instanceof SizerError)) return undefined;
  if (error.stopsRun) return error.code;
  return error.code === "sizing_cancelled" ? "worker_lost" : undefined;
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
