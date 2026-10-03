import { randomUUID } from "node:crypto";

import {
  followsJira,
  type BountyProposalStore,
  type BountyRunStore,
  type BountySpecStore,
  type JiraBoardStore,
  type JiraBoardSummary,
  type JiraIssueStore,
  type NewBountyProfile,
  type NewBountySpec,
  type StoredBountyProposal,
  type StoredBountyRun,
  type StoredTicket,
  type TicketStore,
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
  TICKET_SPEC_HASH_VERSION,
  ticketSpecHash,
  trimSpec,
  type BountyRunOutcome,
  type BountyRunPlannedIssue,
  type BountySizingResult,
  type CategoryMatch,
  type RespecRequest,
  type SpecDraft,
  type StepResult,
  type StepSettings,
  type TicketContent,
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
 * A ticket a board's run is about to size. A backlog run knows why it
 * picked each one; a ticket a person picked has no such reason.
 */
type RunCandidate = JiraIssueDto & {
  readonly categories?: readonly CategoryMatch[];
};

/**
 * One ticket a run sizes: a board's issue, read from Jira and imported as a
 * ticket when the run reaches it, or a ticket the platform already holds.
 */
type Candidate =
  | { readonly source: "jira"; readonly issue: RunCandidate }
  | {
      readonly source: "ticket";
      readonly ticket: StoredTicket;
      readonly categories: readonly CategoryMatch[];
    };

/** The board a run reads through, as `JiraBoardStore.forRun` answers. */
interface BoardRead {
  readonly board: JiraBoardSummary;
  readonly connectionId: string;
}

/**
 * What a run reads its tickets through. A board's run has both; a ticket's
 * run has its ticket's board when it came from one, and a client while its
 * Jira issue is still there to read. A ticket written here has neither.
 */
interface RunScope {
  readonly board: BoardRead | null;
  readonly client: RunJiraClient | null;
}

/** What a run sized a ticket from, and what its outcome is named by. */
interface ReadTicket {
  readonly ticket: StoredTicket;
  readonly content: TicketContent;
  readonly specHash: string;
  readonly base: OutcomeBase;
}

interface OutcomeBase {
  readonly externalIssueId: string;
  readonly issueKey: string;
  readonly ticketId?: string;
}

type Step<T> =
  | { readonly value: T; readonly fatalCode?: undefined }
  | { readonly value?: undefined; readonly fatalCode: string };

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
  /** The tickets runs size, and import Jira's issues as. */
  readonly tickets: TicketStore;
  /** The spec revisions a `respec` run changes. */
  readonly specs: BountySpecStore;
  /** The model behind every call a run makes: the spec draft and the size. */
  readonly caller: StructuredCaller;
  /**
   * A Jira site's client. Only a board's run and a ticket still following
   * its Jira issue ask for one; a deployment without Jira answers
   * `reconnect`, and sizes the tickets written here all the same.
   */
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  /**
   * The outline of a repository, from its current snapshot, or null when
   * it has none yet. Absent, no draft is shown one.
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
   * Called for each proposal whose spec was drafted beside a repository
   * snapshot, to measure its complexity profile from that snapshot's code.
   * Must not throw: the proposal is already written.
   */
  readonly onProposalDrafted?: (
    organizationId: string,
    input: NewBountyProfile,
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
    const { runs } = this.#options;
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
      if (run.kind === "backlog" || run.kind === "issue") {
        await this.#boardRun(organizationId, run, leaseToken, controller);
      } else if (run.kind === "respec") {
        await this.#respec(organizationId, run, leaseToken, controller.signal);
      } else {
        await this.#ticketRun(organizationId, run, leaseToken, controller);
      }
    } finally {
      (this.#options.clearInterval ?? clearInterval)(heartbeat);
    }
  }

  /** A board's backlog, or one of its tickets a person picked (`issue`). */
  async #boardRun(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    const { runs, boards, proposals } = this.#options;
    const fail = (fatalErrorCode: string) =>
      runs.finish(organizationId, run.id, leaseToken, "failed", {
        fatalErrorCode,
      });
    const registered =
      run.boardId === null
        ? null
        : await boards.forRun(organizationId, run.boardId);
    if (registered === null) {
      await fail("board_unavailable");
      return;
    }
    const clientResult = await this.#options.clientFor(
      organizationId,
      registered.connectionId,
    );
    if (!clientResult.ok) {
      await fail(clientResult.reason);
      return;
    }

    let selected: {
      issues: RunCandidate[];
      candidatesScanned: number;
      skippedLive: number;
      scanLimitReached: boolean;
    };
    try {
      if (run.kind === "issue") {
        /*
          One ticket someone picked, named in the plan when the run was
          created. Read again here rather than trusted from the plan: its
          dates and status are what the pointer records, and the ticket
          may have moved or gone since it was picked.
        */
        const target = run.planned[0];
        if (target === undefined) {
          await fail("issue_unavailable");
          return;
        }
        const picked = await clientResult.client.issue(target.externalIssueId);
        // Split into sub-tasks since it was picked: priced through them,
        // as a backlog run would, never itself.
        if ((picked.subtaskCount ?? 0) > 0) {
          await fail("issue_has_subtasks");
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
          now: (this.#options.now ?? (() => new Date()))(),
        });
      }
    } catch (error) {
      await fail(jiraCode(error));
      return;
    }

    await this.#sizeAll(
      organizationId,
      run,
      leaseToken,
      controller,
      selected.issues.map((issue) => ({ source: "jira", issue })),
      { board: registered, client: clientResult.client },
      selected,
    );
  }

  /**
   * One of the organization's tickets: sized for the first time (`ticket`),
   * or again for the proposal it has (`reprice`). Read through its Jira
   * issue while it follows one, and as the platform holds it otherwise.
   */
  async #ticketRun(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    const { runs, proposals, tickets } = this.#options;
    const fail = (fatalErrorCode: string) =>
      runs.finish(organizationId, run.id, leaseToken, "failed", {
        fatalErrorCode,
      });

    let ticket: StoredTicket | null;
    let categories: readonly CategoryMatch[] = [];
    if (run.kind === "reprice") {
      const source =
        run.sourceProposalId === null
          ? null
          : await proposals.get(organizationId, run.sourceProposalId);
      ticket =
        source === null
          ? null
          : await tickets.get(organizationId, source.ticketId);
      if (
        source === null ||
        ticket === null ||
        source.revision !== run.sourceRevision
      ) {
        await fail("proposal_changed");
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
      const key = planKey(ticket);
      categories =
        origin?.planned.find((planned) => planned.externalIssueId === key)
          ?.categories ?? [];
    } else {
      ticket =
        run.ticketId === null
          ? null
          : await tickets.get(organizationId, run.ticketId);
      if (ticket === null) {
        await fail("ticket_unavailable");
        return;
      }
    }

    const scope = await this.#scopeFor(organizationId, ticket);
    if (scope.value === undefined) {
      await fail(scope.fatalCode);
      return;
    }
    /*
      The rule an issue run keeps: a ticket split into sub-tasks in Jira
      since it was imported is priced through them, never itself. A read
      that fails is left to the text's own read below, which says why.
    */
    const { client } = scope.value;
    if (run.kind === "ticket" && client !== null && ticket.jira !== null) {
      const picked = await client
        .issue(ticket.jira.externalId)
        .catch(() => null);
      if ((picked?.subtaskCount ?? 0) > 0) {
        await fail("issue_has_subtasks");
        return;
      }
    }
    await this.#sizeAll(
      organizationId,
      run,
      leaseToken,
      controller,
      [{ source: "ticket", ticket, categories }],
      scope.value,
      { candidatesScanned: 1, skippedLive: 0, scanLimitReached: false },
    );
  }

  /**
   * The board a ticket came through and the client to read it with. A
   * ticket whose issue has gone keeps its board's settings but is not read;
   * one written here has neither.
   */
  async #scopeFor(
    organizationId: string,
    ticket: StoredTicket,
  ): Promise<Step<RunScope>> {
    if (ticket.jira === null) return { value: { board: null, client: null } };
    const registered = await this.#options.boards.forRun(
      organizationId,
      ticket.jira.boardId,
    );
    if (registered === null || !followsJira(ticket)) {
      return { value: { board: registered, client: null } };
    }
    const ready = await this.#options.clientFor(
      organizationId,
      registered.connectionId,
    );
    return ready.ok
      ? { value: { board: registered, client: ready.client } }
      : { fatalCode: ready.reason };
  }

  /**
   * Sizes what a run selected: the plan first, then each ticket, three at a
   * time, then the run's end.
   */
  async #sizeAll(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    controller: AbortController,
    candidates: readonly Candidate[],
    scope: RunScope,
    stats: {
      readonly candidatesScanned: number;
      readonly skippedLive: number;
      readonly scanLimitReached: boolean;
    },
  ): Promise<void> {
    const { runs } = this.#options;
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
      run.id,
      leaseToken,
      candidates.map(planEntry),
    );
    if (planned === null) return;

    /*
      How the board counts scenario weight, read once for the run. Every
      step this run writes is zero, since a fresh draft has added
      nothing, but it is written with the settings that will count what
      a reviewer adds to it. A ticket with no board counts with the
      defaults.
    */
    const pricing = boardPricingSchema.safeParse(scope.board?.board.pricing);
    const stepSettings = resolveStepSettings(
      pricing.success ? pricing.data.step : {},
    );
    /*
      The repository each ticket is about: its own, or its board's. Read
      once per repository for the run, like the settings above, so a
      backlog's tickets are drafted beside the same snapshot.
    */
    const outlines = new Map<string, Promise<RepositoryOutlineRead | null>>();
    const outline = (ticket: StoredTicket) => {
      const repoId = ticket.repoId ?? scope.board?.board.sourceRepoId ?? null;
      if (repoId === null) return Promise.resolve(null);
      let read = outlines.get(repoId);
      if (read === undefined) {
        read = this.#outline(organizationId, repoId);
        outlines.set(repoId, read);
      }
      return read;
    };

    const outcomes: BountyRunOutcome[] = [];
    let nextIndex = 0;
    let fatalCode: string | undefined;

    const worker = async () => {
      while (
        fatalCode === undefined &&
        !controller.signal.aborted &&
        nextIndex < candidates.length
      ) {
        const candidate = candidates[nextIndex];
        nextIndex += 1;
        if (candidate === undefined) return;
        const outcome = await this.#processCandidate(
          organizationId,
          planned,
          leaseToken,
          candidate,
          scope,
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
            run.id,
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
      Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () =>
        worker(),
      ),
    );

    const succeeded = outcomes.filter(
      ({ status }) => status !== "failed",
    ).length;
    const failed = outcomes.filter(({ status }) => status === "failed").length;
    const status =
      fatalCode !== undefined || (failed > 0 && succeeded === 0)
        ? "failed"
        : failed > 0
          ? "partial"
          : "succeeded";
    await runs.finish(organizationId, run.id, leaseToken, status, {
      ...(fatalCode === undefined ? {} : { fatalErrorCode: fatalCode }),
      candidatesScanned: stats.candidatesScanned,
      skippedLive: stats.skippedLive,
      scanLimitReached: stats.scanLimitReached,
    });
  }

  /** A repository's outline, or null when there is none to read. */
  async #outline(
    organizationId: string,
    repoId: string,
  ): Promise<RepositoryOutlineRead | null> {
    const read = this.#options.outlineFor;
    if (read === undefined) return null;
    try {
      return await read(organizationId, repoId);
    } catch (error) {
      // The outline helps a weight; it is not what a size stands on, so a
      // repository that cannot be read leaves the draft without it.
      this.#options.onBackgroundError?.("bounty_outline_unavailable", error);
      return null;
    }
  }

  /**
   * A ticket's text, as a run sizes it. A board's issue is read from Jira
   * and imported, creating or refreshing its ticket. A ticket the platform
   * holds is read through its Jira issue while it has one, and refreshed
   * from it; one whose issue has gone, or that was written here, is sized
   * from what is stored.
   */
  async #readCandidate(
    organizationId: string,
    candidate: Candidate,
    scope: RunScope,
  ): Promise<
    Step<ReadTicket | { readonly failed: OutcomeBase & { code: string } }>
  > {
    if (candidate.source === "ticket") {
      const { ticket } = candidate;
      const base = baseOf(ticket);
      const read = await this.#ticketContent(
        organizationId,
        ticket,
        scope.client,
      );
      if (read.fatalCode !== undefined) return read;
      if ("code" in read.value) {
        return { value: { failed: { ...base, code: read.value.code } } };
      }
      return {
        value: {
          ticket,
          content: read.value.content,
          specHash: read.value.specHash,
          base,
        },
      };
    }

    const { issue } = candidate;
    const base = { externalIssueId: issue.id, issueKey: issue.key };
    if (!validDate(issue.created) || !validDate(issue.updated)) {
      return { value: { failed: { ...base, code: "invalid_issue_dates" } } };
    }
    const board = scope.board;
    const client = scope.client;
    if (board === null || client === null) {
      return { value: { failed: { ...base, code: "issue_pointer" } } };
    }
    let spec: JiraIssueSpec;
    try {
      spec = await client.issueSpec(issue.id);
    } catch (error) {
      if (error instanceof JiraApiError && error.isNotFound) {
        // A ticket imported before keeps its text; this one is not sized.
        await this.#options.issues.markRemovedByExternal(
          organizationId,
          board.board.id,
          issue.id,
        );
        return { value: { failed: { ...base, code: "issue_unavailable" } } };
      }
      const code = jiraCode(error);
      return code === "reconnect" || code === "scope"
        ? { fatalCode: code }
        : { value: { failed: { ...base, code } } };
    }
    const content = jiraContent(spec);
    const pointer = await this.#options.issues.upsert(
      organizationId,
      board.board.id,
      {
        externalId: issue.id,
        key: issue.key,
        statusCategory: issue.statusCategory,
        remoteCreatedAt: issue.created,
        remoteUpdatedAt: issue.updated,
      },
      content,
    );
    const ticket =
      pointer === null
        ? null
        : await this.#options.tickets.get(organizationId, pointer.ticketId);
    if (ticket === null) {
      return { value: { failed: { ...base, code: "issue_pointer" } } };
    }
    return {
      value: {
        ticket,
        content,
        specHash: spec.pricingSpecHash,
        base: { ...base, ticketId: ticket.id },
      },
    };
  }

  /**
   * What a ticket says now, and its fingerprint: Jira's text while it
   * follows an issue (written back to the ticket), and the stored text
   * otherwise. An issue Jira no longer has is marked so, and the ticket is
   * read as stored from then on.
   */
  async #ticketContent(
    organizationId: string,
    ticket: StoredTicket,
    client: RunJiraClient | null,
  ): Promise<
    Step<
      | { readonly content: TicketContent; readonly specHash: string }
      | { readonly code: string }
    >
  > {
    if (ticket.jira === null || client === null || !followsJira(ticket)) {
      return { value: await stored(ticket) };
    }
    let spec: JiraIssueSpec;
    try {
      spec = await client.issueSpec(ticket.jira.externalId);
    } catch (error) {
      if (error instanceof JiraApiError && error.isNotFound) {
        await this.#options.issues.markRemoved(
          organizationId,
          ticket.jira.issueId,
        );
        return { value: await stored(ticket) };
      }
      const code = jiraCode(error);
      return code === "reconnect" || code === "scope"
        ? { fatalCode: code }
        : { value: { code } };
    }
    const content = jiraContent(spec);
    // Sized from what Jira said whether or not the copy is kept: a copy that
    // fails to write is not Jira failing, and the next read writes it again.
    await this.#options.tickets
      .refreshFromJira(organizationId, ticket.id, content)
      .catch((error: unknown) => {
        this.#options.onBackgroundError?.(
          "bounty_ticket_refresh_failed",
          error,
        );
        return false;
      });
    return { value: { content, specHash: spec.pricingSpecHash } };
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
    signal: AbortSignal,
  ): Promise<void> {
    const { runs, proposals, tickets } = this.#options;
    const source =
      claimed.sourceProposalId === null
        ? null
        : await proposals.get(organizationId, claimed.sourceProposalId);
    const ticket =
      source === null
        ? null
        : await tickets.get(organizationId, source.ticketId);
    if (
      claimed.respec === null ||
      ticket === null ||
      !respeccable(source, claimed)
    ) {
      await runs.finish(organizationId, claimed.id, leaseToken, "failed", {
        fatalErrorCode: "proposal_changed",
      });
      return;
    }
    const run = await runs.recordPlan(organizationId, claimed.id, leaseToken, [
      planEntry({ source: "ticket", ticket, categories: [] }),
    ]);
    if (run === null) return;

    const outcome = await this.#respecOutcome(
      organizationId,
      run,
      leaseToken,
      source,
      ticket,
      claimed.respec,
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
    ticket: StoredTicket,
    request: RespecRequest,
    signal: AbortSignal,
  ): Promise<Step<BountyRunOutcome>> {
    const base = { ...baseOf(ticket), proposalId: source.id };
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
      const scope = await this.#scopeFor(organizationId, ticket);
      if (scope.value === undefined) return { fatalCode: scope.fatalCode };
      const read = await this.#ticketContent(
        organizationId,
        ticket,
        scope.value.client,
      );
      if (read.value === undefined) return { fatalCode: read.fatalCode };
      if ("code" in read.value) return failed(read.value.code);
      const { content } = read.value;
      if (
        source.specHashVersion !== TICKET_SPEC_HASH_VERSION ||
        read.value.specHash !== source.specHash
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
          summary: content.title,
          descriptionText: content.description,
          issueType: content.issueType,
          components: content.components,
          labels: content.labels,
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

  async #processCandidate(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    candidate: Candidate,
    scope: RunScope,
    signal: AbortSignal,
    stepSettings: StepSettings,
    outlineOf: (ticket: StoredTicket) => Promise<RepositoryOutlineRead | null>,
  ): Promise<{ value?: BountyRunOutcome; fatalCode?: string }> {
    const read = await this.#readCandidate(organizationId, candidate, scope);
    if (read.value === undefined) return { fatalCode: read.fatalCode };
    if ("failed" in read.value) {
      return { value: { ...read.value.failed, status: "failed" } };
    }
    const { ticket, content, specHash, base } = read.value;
    const outline = await outlineOf(ticket);

    let sizing: BountySizingResult;
    let actualModel = run.requestedModel;
    let drafted: NewBountySpec | undefined;
    // What each model call spent, for the calls that were made.
    const spent: SizingUsage[] = [];
    let technicalFailure = false;
    let draftFailure = false;
    if (content.inputTruncated) {
      sizing = fixedUnsized(
        "spec_too_large",
        "The ticket is too large to size safely.",
      );
    } else if (
      content.title.length + content.description.length <
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
            summary: content.title,
            descriptionText: content.description,
            issueType: content.issueType,
            components: content.components,
            labels: content.labels,
            ...(outline === null ? {} : { repositoryOutline: outline.text }),
          },
          request,
        );
        spent.push(draft.usage);
        drafted = {
          specHash,
          specHashVersion: TICKET_SPEC_HASH_VERSION,
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
            summary: content.title,
            descriptionText: content.description,
            issueType: content.issueType,
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
      ticketId: ticket.id,
      specHash,
      specHashVersion: TICKET_SPEC_HASH_VERSION,
      rateCard: run.rateCard,
      sizing,
      inputTruncated: content.inputTruncated,
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
    // A spec drafted beside a snapshot is profiled against that snapshot.
    if (
      drafted !== undefined &&
      outline !== null &&
      created.proposal.specRevision !== null
    ) {
      this.#options.onProposalDrafted?.(organizationId, {
        proposalId: created.proposal.id,
        specRevision: created.proposal.specRevision,
        specHash: drafted.specHash,
        snapshotId: outline.snapshotId,
        ticket: { issueType: content.issueType, priority: content.priority },
      });
    }

    return {
      value: {
        ...base,
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
 * What a plan entry calls a ticket: Jira's issue id for one imported from
 * a board, which is what a board's plan named it by before it was
 * imported, and the ticket's own id for one written here.
 */
function planKey(ticket: StoredTicket): string {
  return ticket.jira?.externalId ?? ticket.id;
}

function baseOf(ticket: StoredTicket): OutcomeBase {
  return {
    externalIssueId: planKey(ticket),
    issueKey: ticket.key,
    ticketId: ticket.id,
  };
}

function planEntry(candidate: Candidate): BountyRunPlannedIssue {
  if (candidate.source === "jira") {
    const { issue } = candidate;
    return {
      externalIssueId: issue.id,
      issueKey: issue.key,
      summary: issue.summary,
      categories: [...(issue.categories ?? [])],
    };
  }
  const { ticket } = candidate;
  return {
    externalIssueId: planKey(ticket),
    issueKey: ticket.key,
    summary: ticket.title,
    ticketId: ticket.id,
    categories: [...candidate.categories],
  };
}

/** Jira's text, as a ticket holds it. */
function jiraContent(spec: JiraIssueSpec): TicketContent {
  return {
    title: spec.summary,
    description: spec.descriptionText,
    issueType: spec.issueType,
    priority: spec.priority,
    labels: spec.labels,
    components: spec.components,
    inputTruncated: spec.inputTruncated,
  };
}

/**
 * A ticket's text as stored, and the fingerprint a proposal of it is
 * priced against: Jira's own hash is this one, so either reads the same.
 */
async function stored(
  ticket: StoredTicket,
): Promise<{ readonly content: TicketContent; readonly specHash: string }> {
  return {
    content: {
      title: ticket.title,
      description: ticket.description,
      issueType: ticket.issueType,
      priority: ticket.priority,
      labels: ticket.labels,
      components: ticket.components,
      inputTruncated: ticket.inputTruncated,
    },
    specHash: await ticketSpecHash(
      ticket.title,
      ticket.description,
      ticket.issueType,
    ),
  };
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
