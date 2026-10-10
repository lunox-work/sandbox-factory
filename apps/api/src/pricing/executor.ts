import { randomUUID } from "node:crypto";

import {
  followsJira,
  type BountyProposalStore,
  type BountyRunStore,
  type BountySpecStore,
  type JiraBoardStore,
  type JiraBoardSummary,
  type JiraIssueStore,
  type LatestBountyContext,
  type NewBountyProfile,
  type NewBountySpec,
  type ProposalRepository,
  type StoredBountyProfile,
  type StoredBountyProposal,
  type StoredBountyRun,
  type StoredBounty,
  type BountyStore,
} from "@sandbox-factory/db";
import {
  JiraApiError,
  JiraAuthError,
  type JiraIssueSpec,
} from "@sandbox-factory/jira";
import {
  boardPricingSchema,
  specDraftSchema,
  type JiraContextDto,
  type JiraIssueDto,
  type JiraIssuePageDto,
} from "@sandbox-factory/shared";
import {
  answerSpec,
  assessRubric,
  checkRespec,
  describeRespec,
  expandSpec,
  pointsDelta,
  priceFor,
  renderSourceContext,
  repositoryLabel,
  resolveStepSettings,
  sameSpec,
  stepUp,
  BOUNTY_SPEC_HASH_VERSION,
  bountySpecHash,
  trimSpec,
  type BountyRunOutcome,
  type BountyRunPlannedIssue,
  type BountyRunProgress,
  type BountySizingResult,
  type CategoryMatch,
  type RespecRequest,
  type SpecDraft,
  type StepResult,
  type StepSettings,
  type BountyContent,
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
import { rubricCode, rubricPrice } from "./rubric.js";
import { selectBacklog, type BacklogPageReader } from "./selection.js";

const HEARTBEAT_MS = 15_000;
const CONCURRENCY = 3;

/**
 * A bounty a board's run is about to size. A backlog run knows why it
 * picked each one; a bounty a person picked has no such reason.
 */
type RunCandidate = JiraIssueDto & {
  readonly categories?: readonly CategoryMatch[];
};

/**
 * One bounty a run sizes: a board's issue, read from Jira and imported as a
 * bounty when the run reaches it, or a bounty the platform already holds.
 */
type Candidate =
  | { readonly source: "jira"; readonly issue: RunCandidate }
  | {
      readonly source: "bounty";
      readonly bounty: StoredBounty;
      readonly categories: readonly CategoryMatch[];
    };

/** The board a run reads through, as `JiraBoardStore.forRun` answers. */
interface BoardRead {
  readonly board: JiraBoardSummary;
  readonly connectionId: string;
}

/**
 * What a run reads its bounties through. A board's run has both; a bounty's
 * run has its bounty's board when it came from one, and a client while its
 * Jira issue is still there to read. A bounty written here has neither.
 */
interface RunScope {
  readonly board: BoardRead | null;
  readonly client: RunJiraClient | null;
}

/** What a run sized a bounty from, and what its outcome is named by. */
interface ReadBounty {
  readonly bounty: StoredBounty;
  readonly content: BountyContent;
  readonly specHash: string;
  readonly base: OutcomeBase;
}

interface OutcomeBase {
  readonly externalIssueId: string;
  /** Jira's key for a board's issue; null for a bounty written here. */
  readonly issueKey: string | null;
  readonly bountyId?: string;
}

type Step<T> =
  | { readonly value: T; readonly fatalCode?: undefined }
  | { readonly value?: undefined; readonly fatalCode: string };

export interface RunJiraClient extends BacklogPageReader {
  /** A board's issues, for finding one by id or by what a person typed. */
  boardIssues(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssuePageDto>;
  issueSpec(issueId: string): Promise<JiraIssueSpec>;
  /** One bounty's list fields, for an `issue` run's single bounty. */
  issue(issueId: string): Promise<JiraIssueDto>;
  /** One issue's context, for a person's sync of it into its bounty. */
  issueContext(issueId: string): Promise<JiraContextDto>;
}

export type RunClientResult =
  | { readonly ok: true; readonly client: RunJiraClient }
  | { readonly ok: false; readonly reason: "not-found" | "reconnect" };

/**
 * A client that could not be had, as a run records it: in snake case, as
 * every other code is. A connection that is gone leaves the board with
 * nothing to read through.
 */
function clientFailureCode(
  reason: Extract<RunClientResult, { ok: false }>["reason"],
): string {
  return reason === "not-found" ? "board_unavailable" : reason;
}

export interface BountyExecutorOptions {
  readonly boards: JiraBoardStore;
  readonly runs: BountyRunStore;
  readonly proposals: BountyProposalStore;
  readonly issues: JiraIssueStore;
  /** The bounties runs size, and import Jira's issues as. */
  readonly bounties: BountyStore;
  /** The spec revisions a `respec` run changes. */
  readonly specs: BountySpecStore;
  /** The model behind every call a run makes: the spec draft and the size. */
  readonly caller: StructuredCaller;
  /**
   * A Jira site's client. Only a board's run and a bounty still following
   * its Jira issue ask for one; a deployment without Jira answers
   * `reconnect`, and sizes the bounties written here all the same.
   */
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  /**
   * The context a bounty holds from its sources (`heldContext`): what a
   * person last synced from its Jira issue and its repository. Absent, no
   * draft or size is shown any.
   */
  readonly contextFor?: (
    organizationId: string,
    bounty: StoredBounty,
  ) => Promise<LatestBountyContext>;
  /**
   * The outline of each of the workspace's repositories a bounty's work
   * could touch, from its current snapshot, in name order; a repository
   * with no snapshot yet has none. Absent, no draft is shown any.
   */
  readonly outlinesFor?: (
    organizationId: string,
  ) => Promise<readonly RepositoryOutlineRead[]>;
  readonly now?: () => Date;
  readonly leaseToken?: () => string;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onWritebackCreated?: (
    organizationId: string,
    operationId: string,
  ) => void;
  /** Resolved by server composition independently of the wake-up callback. */
  readonly profilingEnabled?: () => boolean;
  /**
   * Called for each proposal whose spec was drafted beside a repository
   * snapshot, to measure its complexity profile from that snapshot's code.
   * The profile row itself is written with the proposal; this only wakes
   * the profiler. Must not throw: the proposal is already written.
   */
  readonly onProposalDrafted?: (
    organizationId: string,
    input: NewBountyProfile,
  ) => void;
  /**
   * A proposal's newest complexity profiles, one per repository its work
   * touches, for the pricing rubric to score a changed spec's code with.
   * Absent, a spec change scores none.
   */
  readonly profileFor?: (
    organizationId: string,
    proposalId: string,
  ) => Promise<readonly StoredBountyProfile[]>;
  /**
   * Called when `execute` itself throws. `code` is fixed; `error` is the
   * thrown value, for the operator's log — it is never sent to a client.
   */
  readonly onBackgroundError?: (code: string, error?: unknown) => void;
}

/**
 * One repository's outline to draft beside, and the snapshot it was drawn
 * from.
 */
export interface RepositoryOutlineRead {
  readonly repoId: string;
  readonly fullName: string;
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
        await this.#oneBountyRun(organizationId, run, leaseToken, controller);
      }
    } catch (error) {
      // A fault nothing above expected, such as a write the database
      // refused. The workers still sizing are stopped, rather than spending
      // model calls until the lease runs out, and the run ends now as failed
      // instead of reading as running until the watchdog calls it lost. A
      // run already finished keeps its outcome: the lease guards the write.
      controller.abort();
      await runs
        .finish(organizationId, run.id, leaseToken, "failed", {
          fatalErrorCode: "internal_error",
        })
        .catch(() => undefined);
      throw error;
    } finally {
      (this.#options.clearInterval ?? clearInterval)(heartbeat);
    }
  }

  /** A board's backlog, or one of its bounties a person picked (`issue`). */
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
      await fail(clientFailureCode(clientResult.reason));
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
          One bounty someone picked, named in the plan when the run was
          created. Read again here rather than trusted from the plan: its
          dates and status are what the pointer records, and the bounty
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
   * One of the organization's bounties: sized for the first time (`bounty`),
   * or again for the proposal it has (`reprice`). Read through its Jira
   * issue while it follows one, and as the platform holds it otherwise.
   */
  async #oneBountyRun(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    const { runs, proposals, bounties } = this.#options;
    const fail = (fatalErrorCode: string) =>
      runs.finish(organizationId, run.id, leaseToken, "failed", {
        fatalErrorCode,
      });

    let bounty: StoredBounty | null;
    let categories: readonly CategoryMatch[] = [];
    if (run.kind === "reprice") {
      const source =
        run.sourceProposalId === null
          ? null
          : await proposals.get(organizationId, run.sourceProposalId);
      bounty =
        source === null
          ? null
          : await bounties.get(organizationId, source.bountyId);
      if (
        source === null ||
        bounty === null ||
        source.revision !== run.sourceRevision
      ) {
        await fail("proposal_changed");
        return;
      }
      /*
        Why the bounty was picked, carried over from the plan its
        proposal came from. A re-price moves the proposal onto this run,
        and a proposal's reasons are read from its run's plan: without
        this, asking the model to look again would quietly take the
        bounty out of its category.
      */
      const origin = await runs.get(organizationId, source.runId);
      const key = planKey(bounty);
      categories =
        origin?.planned.find((planned) => planned.externalIssueId === key)
          ?.categories ?? [];
    } else {
      bounty =
        run.bountyId === null
          ? null
          : await bounties.get(organizationId, run.bountyId);
      if (bounty === null) {
        await fail("bounty_unavailable");
        return;
      }
    }

    const scope = await this.#scopeFor(organizationId, bounty);
    if (scope.value === undefined) {
      await fail(scope.fatalCode);
      return;
    }
    /*
      The rule an issue run keeps: an issue split into sub-tasks in Jira
      since it was imported is priced through them, never itself. A read
      that fails is left to the text's own read below, which says why.
    */
    const { client } = scope.value;
    if (run.kind === "bounty" && client !== null && bounty.jira !== null) {
      const picked = await client
        .issue(bounty.jira.externalId)
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
      [{ source: "bounty", bounty, categories }],
      scope.value,
      { candidatesScanned: 1, skippedLive: 0, scanLimitReached: false },
    );
  }

  /**
   * The board a bounty came through and the client to read it with. A
   * bounty whose issue has gone keeps its board's settings but is not read;
   * one written here has neither.
   */
  async #scopeFor(
    organizationId: string,
    bounty: StoredBounty,
  ): Promise<Step<RunScope>> {
    if (bounty.jira === null) return { value: { board: null, client: null } };
    const registered = await this.#options.boards.forRun(
      organizationId,
      bounty.jira.boardId,
    );
    if (registered === null || !followsJira(bounty)) {
      return { value: { board: registered, client: null } };
    }
    const ready = await this.#options.clientFor(
      organizationId,
      registered.connectionId,
    );
    return ready.ok
      ? { value: { board: registered, client: ready.client } }
      : { fatalCode: clientFailureCode(ready.reason) };
  }

  /**
   * Sizes what a run selected: the plan first, then each bounty, three at a
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
      What the run is about to size, before the first bounty is sent to
      the model. A page opened mid-run lists it with each bounty's state,
      so what is still to come shows as well as what is done. Each bounty
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
      a reviewer adds to it. A bounty with no board counts with the
      defaults.
    */
    const pricing = boardPricingSchema.safeParse(scope.board?.board.pricing);
    const stepSettings = resolveStepSettings(
      pricing.success ? pricing.data.step : {},
    );
    /*
      The repositories any bounty's work could touch: every one the
      workspace has connected. Read once for the run, like the settings
      above, so a backlog's bounties are drafted beside the same snapshots.
    */
    let outlines: Promise<readonly RepositoryOutlineRead[]> | undefined;
    const outline = () => (outlines ??= this.#outlines(organizationId));

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

  /**
   * What a run sizing one bounty has just made, for the page following it.
   * A board's run sizes many at once and writes none: its page lists the
   * proposals as they land. A preview that cannot be written is left out;
   * the proposal is what counts, and a lost lease is caught when it is
   * written.
   */
  async #preview(
    organizationId: string,
    run: StoredBountyRun,
    leaseToken: string,
    progress: BountyRunProgress,
  ): Promise<void> {
    if (run.planned.length !== 1) return;
    await this.#options.runs
      .recordProgress(organizationId, run.id, leaseToken, progress)
      .catch(() => false);
  }

  /**
   * The context a bounty holds, or none when it cannot be read: like the
   * outline, it informs a size and is not what one stands on.
   */
  async #context(
    organizationId: string,
    bounty: StoredBounty,
  ): Promise<LatestBountyContext> {
    const read = this.#options.contextFor;
    if (read === undefined) return { jira: null, github: null };
    try {
      return await read(organizationId, bounty);
    } catch (error) {
      this.#options.onBackgroundError?.("bounty_context_unavailable", error);
      return { jira: null, github: null };
    }
  }

  /** The workspace's repositories' outlines, or none when they cannot be read. */
  async #outlines(
    organizationId: string,
  ): Promise<readonly RepositoryOutlineRead[]> {
    const read = this.#options.outlinesFor;
    if (read === undefined) return [];
    try {
      return await read(organizationId);
    } catch (error) {
      // The outlines help a weight; they are not what a size stands on, so
      // repositories that cannot be read leave the draft without them.
      this.#options.onBackgroundError?.("bounty_outline_unavailable", error);
      return [];
    }
  }

  /**
   * A bounty's text, as a run sizes it. A board's issue is read from Jira
   * and imported, creating or refreshing its bounty. A bounty the platform
   * holds is read through its Jira issue while it has one, and refreshed
   * from it; one whose issue has gone, or that was written here, is sized
   * from what is stored.
   */
  async #readCandidate(
    organizationId: string,
    candidate: Candidate,
    scope: RunScope,
  ): Promise<
    Step<ReadBounty | { readonly failed: OutcomeBase & { code: string } }>
  > {
    if (candidate.source === "bounty") {
      const { bounty } = candidate;
      const base = baseOf(bounty);
      const read = await this.#bountyContent(
        organizationId,
        bounty,
        scope.client,
      );
      if (read.fatalCode !== undefined) return read;
      if ("code" in read.value) {
        return { value: { failed: { ...base, code: read.value.code } } };
      }
      return {
        value: {
          bounty,
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
        // A bounty imported before keeps its text; this one is not sized.
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
      },
      content,
    );
    // The categories the run picked it for are the bounty's, as an
    // import's are. One picked by hand says nothing about them, so leaves
    // whatever the board's scan last said.
    const picked = issue.categories ?? [];
    if (pointer !== null && picked.length > 0) {
      await this.#options.bounties.categorize(
        organizationId,
        pointer.bountyId,
        picked,
      );
    }
    const bounty =
      pointer === null
        ? null
        : await this.#options.bounties.get(organizationId, pointer.bountyId);
    if (bounty === null) {
      return { value: { failed: { ...base, code: "issue_pointer" } } };
    }
    return {
      value: {
        bounty,
        content,
        specHash: spec.pricingSpecHash,
        base: { ...base, bountyId: bounty.id },
      },
    };
  }

  /**
   * What a bounty says now, and its fingerprint: Jira's text while it
   * follows an issue (written back to the bounty), and the stored text
   * otherwise. An issue Jira no longer has is marked so, and the bounty is
   * read as stored from then on.
   */
  async #bountyContent(
    organizationId: string,
    bounty: StoredBounty,
    client: RunJiraClient | null,
  ): Promise<
    Step<
      | { readonly content: BountyContent; readonly specHash: string }
      | { readonly code: string }
    >
  > {
    if (bounty.jira === null || client === null || !followsJira(bounty)) {
      return { value: await stored(bounty) };
    }
    let spec: JiraIssueSpec;
    try {
      spec = await client.issueSpec(bounty.jira.externalId);
    } catch (error) {
      if (error instanceof JiraApiError && error.isNotFound) {
        await this.#options.issues.markRemoved(
          organizationId,
          bounty.jira.issueId,
        );
        return { value: await stored(bounty) };
      }
      const code = jiraCode(error);
      return code === "reconnect" || code === "scope"
        ? { fatalCode: code }
        : { value: { code } };
    }
    const content = jiraContent(spec);
    // Sized from what Jira said whether or not the copy is kept: a copy that
    // fails to write is not Jira failing, and the next read writes it again.
    await this.#options.bounties
      .refreshFromJira(organizationId, bounty.id, content)
      .catch((error: unknown) => {
        this.#options.onBackgroundError?.("bounty_refresh_failed", error);
        return false;
      });
    return { value: { content, specHash: spec.pricingSpecHash } };
  }

  /**
   * A reviewer's change to one proposal's spec: the spec revised as asked,
   * then the size moved by the scenario step, from the base and with the
   * settings the proposal's step already holds. The model's size is not
   * asked for again: the base is "what the bounty asks for", and what the
   * reviewer added to the spec is the step's to count.
   *
   * One bounty, so no workers: a plan of one, its outcome, and the run's
   * end. The outcome carries the size before the change and the points it
   * moved, for the line the reviewer reads when it lands.
   */
  async #respec(
    organizationId: string,
    claimed: StoredBountyRun,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { runs, proposals, bounties } = this.#options;
    const source =
      claimed.sourceProposalId === null
        ? null
        : await proposals.get(organizationId, claimed.sourceProposalId);
    const bounty =
      source === null
        ? null
        : await bounties.get(organizationId, source.bountyId);
    if (
      claimed.respec === null ||
      bounty === null ||
      !respeccable(source, claimed)
    ) {
      await runs.finish(organizationId, claimed.id, leaseToken, "failed", {
        fatalErrorCode: "proposal_changed",
      });
      return;
    }
    const run = await runs.recordPlan(organizationId, claimed.id, leaseToken, [
      planEntry({ source: "bounty", bounty, categories: [] }),
    ]);
    if (run === null) return;

    const outcome = await this.#respecOutcome(
      organizationId,
      run,
      leaseToken,
      source,
      bounty,
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
    bounty: StoredBounty,
    request: RespecRequest,
    signal: AbortSignal,
  ): Promise<Step<BountyRunOutcome>> {
    const base = { ...baseOf(bounty), proposalId: source.id };
    const failed = (code: string) => ({
      value: { ...base, status: "failed" as const, code },
    });

    const { specs } = this.#options;
    // The step counts from where its base was set: a reviewer's resize,
    // or else the sizing draft.
    const baseRevision = source.step.baseRevision;
    const [current, sized] = await Promise.all([
      specs.get(organizationId, source.id, source.specRevision),
      baseRevision === undefined
        ? specs.sizedRevision(organizationId, source.id, source.specRevision)
        : specs.get(organizationId, source.id, baseRevision),
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
        The bounty, read again: the model needs to know what the scenarios
        are about, and the read says whether the bounty still says what it
        said when the proposal was sized. A change made of a bounty that
        has moved on would grow a spec the next re-price throws away.
      */
      const scope = await this.#scopeFor(organizationId, bounty);
      if (scope.value === undefined) return { fatalCode: scope.fatalCode };
      const read = await this.#bountyContent(
        organizationId,
        bounty,
        scope.value.client,
      );
      if (read.value === undefined) return { fatalCode: read.fatalCode };
      if ("code" in read.value) return failed(read.value.code);
      const { content } = read.value;
      if (
        source.specHashVersion !== BOUNTY_SPEC_HASH_VERSION ||
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
        bounty: {
          summary: content.title,
          descriptionText: content.description,
          components: content.components,
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
    const counted = stepUp(
      source.step.base,
      sized.draft,
      next,
      source.step.settings,
    );
    const step =
      counted === null || baseRevision === undefined
        ? counted
        : { ...counted, baseRevision };
    if (step === null) {
      return { value: { ...failed("spec_unweighed").value, ...spent } };
    }
    /*
      The rubric scores the changed spec with the code as last measured.
      A proposal the rubric sized stays sized by it: the whole spec is
      counted, so the step only says what changed. Otherwise the step
      prices the change, as it did before the rubric.
    */
    const profiles =
      (await this.#options.profileFor?.(organizationId, source.id)) ?? [];
    const rubric = assessRubric({
      spec: next,
      code: rubricCode(
        profiles,
        source.rubric?.code.status === "pending" ? "pending" : "unavailable",
      ),
      weightPoints: source.step.settings.weightPoints,
    });
    const priced =
      source.sizedBy === "rubric" ? rubricPrice(rubric, run) : null;
    const amountMinor =
      priced?.amountMinor ?? priceFor(step.complexity, run.rateCard);
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
        rubric,
        ...(priced === null ? {} : { complexity: priced.complexity }),
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
    outlinesOf: () => Promise<readonly RepositoryOutlineRead[]>,
  ): Promise<{ value?: BountyRunOutcome; fatalCode?: string }> {
    const read = await this.#readCandidate(organizationId, candidate, scope);
    if (read.value === undefined) return { fatalCode: read.fatalCode };
    if ("failed" in read.value) {
      return { value: { ...read.value.failed, status: "failed" } };
    }
    const { bounty, content, specHash, base } = read.value;
    // Each repository under a label of its own, the same in its outline
    // and its documents, which the draft names the ones it touches by.
    const outlines = await outlinesOf();
    const labels = new Map(
      outlines.map(({ fullName }, index) => [fullName, repositoryLabel(index)]),
    );
    const repositoryOutline = outlines
      .map(({ text }, index) => `=== ${repositoryLabel(index)} ===\n${text}`)
      .join("\n\n");
    // What its sources add, as synced: the draft and the size see it, and
    // the proposal records which versions they saw.
    const held = await this.#context(organizationId, bounty);
    const sourceContext = renderSourceContext(
      {
        jira: held.jira?.content ?? null,
        github: held.github?.content ?? null,
      },
      labels,
    );

    let sizing: BountySizingResult;
    let actualModel = run.requestedModel;
    let drafted: NewBountySpec | undefined;
    // The outlined repositories the draft said the work changes.
    let touched: ProposalRepository[] = [];
    // What each model call spent, for the calls that were made.
    const spent: SizingUsage[] = [];
    let technicalFailure = false;
    let draftFailure = false;
    if (content.inputTruncated) {
      sizing = fixedUnsized(
        "spec_too_large",
        "The bounty is too large to size safely.",
      );
    } else if (
      content.title.length + content.description.length <
      run.selection.minSpecChars
    ) {
      sizing = fixedUnsized(
        "insufficient_spec",
        "The bounty does not contain enough detail to size.",
      );
    } else {
      /*
        The spec and the size are asked for side by side, from the same
        read: neither reads the other, and a page following the run shows
        each as it returns. Nothing prices from the spec yet, so a draft
        that fails costs the bounty its spec and not its proposal: the size
        still stands, and the outcome says the spec is missing. What stops
        a run for one call stops the other too, since it would meet the
        same refusal; the first such code is the cause.
      */
      // Joined rather than forwarded: a run already aborted is aborted here
      // too, which a listener added now would never hear.
      const calls = new AbortController();
      const callSignal = AbortSignal.any([signal, calls.signal]);
      let fatalCode: string | undefined;
      const stop = (code: string) => {
        fatalCode ??= code;
        calls.abort();
      };
      const request: SizingRequestOptions = {
        signal: callSignal,
        ...(run.deadlineAt === null
          ? {}
          : { deadlineAt: new Date(run.deadlineAt) }),
      };
      // Once the run is stopping, the other call's failure is that stop and
      // not news: the page waits for the run's own end instead.
      const preview = async (progress: BountyRunProgress) => {
        if (callSignal.aborted) return;
        await this.#preview(organizationId, run, leaseToken, progress);
      };

      const draftCall = (async () => {
        try {
          const draft = await this.#options.caller.call(
            draftSpecTool,
            {
              summary: content.title,
              descriptionText: content.description,
              components: content.components,
              ...(repositoryOutline === "" ? {} : { repositoryOutline }),
              ...(sourceContext === "" ? {} : { sourceContext }),
            },
            request,
          );
          spent.push(draft.usage);
          touched = outlines.flatMap(({ repoId, snapshotId }, index) =>
            draft.result.repositories.includes(repositoryLabel(index))
              ? [{ repoId, snapshotId }]
              : [],
          );
          drafted = {
            specHash,
            specHashVersion: BOUNTY_SPEC_HASH_VERSION,
            draft: draft.result.spec,
            origin: "draft",
            actualModel: draft.actualModel,
            promptVersion: draftSpecTool.promptVersion,
          };
          await preview({ spec: draft.result.spec });
        } catch (error) {
          const code = fatalCodeOf(error);
          if (code !== undefined) return stop(code);
          draftFailure = true;
          await preview({ spec: null });
        }
      })();

      const sizeCall = (async (): Promise<BountySizingResult | undefined> => {
        try {
          const sized = await this.#options.caller.call(
            sizeBountyTool,
            {
              summary: content.title,
              descriptionText: content.description,
              ...(sourceContext === "" ? {} : { sourceContext }),
            },
            request,
          );
          actualModel = sized.actualModel;
          spent.push(sized.usage);
          await preview({ sizing: sized.result });
          return sized.result;
        } catch (error) {
          const code = fatalCodeOf(error);
          if (code !== undefined) {
            stop(code);
            return undefined;
          }
          technicalFailure = true;
          await preview({ sizing: null });
          return fixedUnsized(
            "sizing_failed",
            "Sizing could not be completed for this bounty.",
          );
        }
      })();

      const [, sized] = await Promise.all([draftCall, sizeCall]);
      if (fatalCode !== undefined) return { fatalCode };
      if (sized === undefined) return { fatalCode: "worker_lost" };
      sizing = sized;
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
      an unsized bounty, which has no base, or one with no draft.
    */
    const step =
      drafted === undefined || sizing.complexity === "unsized"
        ? null
        : stepUp(sizing.complexity, drafted.draft, drafted.draft, stepSettings);
    const amountMinor = priceFor(
      step?.complexity ?? sizing.complexity,
      run.rateCard,
    );
    /*
      The rubric scores the fresh draft now, so the reviewer sees what the
      size will be built from; the code is measured after, and the rubric
      takes the size over from the model only then (`./rubric.ts`).
    */
    const profiling =
      touched.length > 0 && this.#options.profilingEnabled?.() === true;
    const rubric =
      drafted === undefined
        ? null
        : assessRubric({
            spec: drafted.draft,
            code: { status: profiling ? "pending" : "unavailable" },
            weightPoints: stepSettings.weightPoints,
          });
    const input = {
      runId: run.id,
      bountyId: bounty.id,
      specHash,
      specHashVersion: BOUNTY_SPEC_HASH_VERSION,
      rateCard: run.rateCard,
      sizing,
      inputTruncated: content.inputTruncated,
      actualModel,
      promptVersion: run.promptVersion,
      amountMinor,
      currency: amountMinor === null ? null : run.rateCard.currency,
      step,
      rubric,
      // What the spec's work touches; nothing when there is no spec.
      repositories: drafted === undefined ? [] : touched,
      contextVersions: {
        jira: held.jira?.version ?? null,
        github: held.github?.version ?? null,
      },
      ...(drafted === undefined ? {} : { spec: drafted }),
      ...(this.#options.profilingEnabled?.() === true
        ? { profileIntent: true }
        : {}),
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
    // A spec is profiled in each repository its work touches, against the
    // snapshot it was drafted beside.
    const specRevision = created.proposal.specRevision;
    if (drafted !== undefined && specRevision !== null) {
      try {
        for (const { snapshotId } of created.proposal.repositories)
          this.#options.onProposalDrafted?.(organizationId, {
            proposalId: created.proposal.id,
            specRevision,
            specHash: drafted.specHash,
            snapshotId,
          });
      } catch (error) {
        this.#options.onBackgroundError?.(
          "bounty_profile_wakeup_failed",
          error,
        );
      }
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
        // Both calls, so a bounty's cost is what it took to propose it.
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
 * What a plan entry calls a bounty: Jira's issue id for one imported from
 * a board, which is what a board's plan named it by before it was
 * imported, and the bounty's own id for one written here.
 */
function planKey(bounty: StoredBounty): string {
  return bounty.jira?.externalId ?? bounty.id;
}

function baseOf(bounty: StoredBounty): OutcomeBase {
  return {
    externalIssueId: planKey(bounty),
    issueKey: bounty.jira?.key ?? null,
    bountyId: bounty.id,
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
  const { bounty } = candidate;
  return {
    externalIssueId: planKey(bounty),
    issueKey: bounty.jira?.key ?? null,
    summary: bounty.title,
    bountyId: bounty.id,
    categories: [...candidate.categories],
  };
}

/** Jira's text, as a bounty holds it. */
function jiraContent(spec: JiraIssueSpec): BountyContent {
  return {
    title: spec.summary,
    description: spec.descriptionText,
    components: spec.components,
    inputTruncated: spec.inputTruncated,
  };
}

/**
 * A bounty's text as stored, and the fingerprint a proposal of it is
 * priced against: Jira's own hash is this one, so either reads the same.
 */
async function stored(
  bounty: StoredBounty,
): Promise<{ readonly content: BountyContent; readonly specHash: string }> {
  return {
    content: {
      title: bounty.title,
      description: bounty.description,
      components: bounty.components,
      inputTruncated: bounty.inputTruncated,
    },
    specHash: await bountySpecHash(bounty.title, bounty.description),
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
 * The code a run ends with when a model call's failure is not the bounty's:
 * a provider that refuses every call, or a run that was cancelled under it.
 * Undefined for a failure only this bounty bears.
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
