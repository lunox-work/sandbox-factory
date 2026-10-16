/**
 * Shared, read-only ticket selection for preview and bounty runs.
 *
 * A run does not take a fixed number of tickets. It reads every open ticket
 * on the board and keeps each one that fits at least one category in the
 * registry (`sandbox-factory`'s `CATEGORIES`), with the reason it fit. What
 * a category is, and what it looks for, is decided there and nowhere here:
 * this file pages, classifies, and leaves out tickets already proposed.
 *
 * A ticket split into sub-tasks is never offered: its sub-tasks are the
 * work, and they are offered in its place, so nothing is priced twice. JQL
 * cannot ask whether a ticket has sub-tasks, so this is decided here, by
 * the count every read carries.
 *
 * **When nothing is left to take**, because no ticket fits a category or
 * every one that does already has a proposal, a run falls back to the
 * oldest open tickets that fit none (`fallbackOldest`, ten by default), so
 * a board is never sized to nothing. Those carry no category: they are
 * "uncategorized", as a ticket picked by hand is.
 */

import type {
  BountyProposalStore,
  JiraBoardSummary,
} from "@sandbox-factory/db";
import { selectionJql } from "@sandbox-factory/jira";
import {
  boardSelectionSchema,
  type BoardSelection,
  type JiraIssueSignalsDto,
  type JiraIssueSignalsPageDto,
} from "@sandbox-factory/shared";
import {
  createClassifier,
  factsFor,
  resolveCategories,
  type CategoryMatch,
  type ResolvedCategory,
} from "sandbox-factory";

const PAGE_SIZE = 100;
/**
 * The most tickets one selection reads from Jira. A ceiling on the *scan*,
 * not on what is selected: it bounds how long a run spends paging a board
 * with tens of thousands of open tickets.
 */
export const MAX_SCAN_CANDIDATES = 5_000;
/**
 * Pages asked for ahead of the one being read, once Jira has said how many
 * tickets there are. Few: a selection that fills its cap stops early, and
 * whatever was read ahead of it is wasted.
 */
const LOOKAHEAD_PAGES = 2;

export interface BacklogPageReader {
  boardIssueSignals(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssueSignalsPageDto>;
}

/** A ticket a run will size, with why it was picked. */
export type SelectedIssue = JiraIssueSignalsDto & {
  /**
   * Every category it fits, in registry order. Empty only for a ticket the
   * oldest-first fallback took.
   */
  readonly categories: readonly CategoryMatch[];
};

export interface BacklogSelectionResult {
  readonly jql: string;
  /** The settings this read used, with every default resolved. */
  readonly selection: BoardSelection;
  /** Every category as this board runs it: on or off, thresholds resolved. */
  readonly categories: readonly ResolvedCategory[];
  readonly issues: SelectedIssue[];
  /**
   * How many scanned tickets fit each category, by id. A ticket in two
   * categories counts in both, and one already proposed still counts: this
   * describes the board, not the run.
   */
  readonly matched: Readonly<Record<string, number>>;
  /** Scanned tickets that fit no category. */
  readonly unmatched: number;
  readonly candidatesScanned: number;
  /** Matching tickets left out because they already have a live proposal. */
  readonly skippedLive: number;
  /**
   * Scanned tickets left out because they are split into sub-tasks, before
   * any category was tried: they are in neither `matched` nor `unmatched`.
   */
  readonly skippedParents: number;
  /** The scan stopped at its ceiling with tickets on the board still unread. */
  readonly scanLimitReached: boolean;
  /** The board's `ticketCap` stopped the selection before the board ended. */
  readonly ticketCapReached: boolean;
  /**
   * Nothing was left to take by category, so `issues` are the oldest open
   * tickets that fit none.
   */
  readonly fallback: boolean;
  readonly total?: number;
}

export interface SelectBacklogOptions {
  readonly organizationId: string;
  readonly board: JiraBoardSummary;
  readonly client: BacklogPageReader;
  readonly proposals?: Pick<BountyProposalStore, "liveExternalIds">;
  readonly now?: Date;
  /** Test-only override; production always uses the 5,000 candidate ceiling. */
  readonly scanLimit?: number;
}

/**
 * Selects every eligible ticket on a board that fits a category.
 * It never writes pointers or runs and never reads issue descriptions.
 */
export async function selectBacklog(
  options: SelectBacklogOptions,
): Promise<BacklogSelectionResult> {
  const { organizationId, board, client, proposals } = options;
  const selection = boardSelectionSchema.parse(board.selection);
  // One clock for the whole read: the JQL's age window and every ticket's
  // facts are measured from the same instant, however long paging takes.
  const now = options.now ?? new Date();
  const jql = selectionJql(selection, {
    projectKey: board.projectKey ?? undefined,
    now,
  });
  const boardId = externalBoardId(board);

  const categories = resolveCategories(selection.categories);
  const classify = createClassifier(selection.categories);
  const matched: Record<string, number> = Object.fromEntries(
    categories.filter(({ enabled }) => enabled).map(({ id }) => [id, 0]),
  );
  const cap = selection.ticketCap ?? Number.POSITIVE_INFINITY;

  const selected: SelectedIssue[] = [];
  // In the order read, which is oldest first: what the fallback takes from.
  const unfitting: JiraIssueSignalsDto[] = [];
  const seen = new Set<string>();
  let startAt = 0;
  let candidatesScanned = 0;
  let skippedLive = 0;
  let skippedParents = 0;
  let unmatched = 0;
  let knownTotal: number | undefined;
  let exhausted = false;
  let capped = false;
  const scanLimit = Math.min(
    Math.max(options.scanLimit ?? MAX_SCAN_CANDIDATES, 1),
    MAX_SCAN_CANDIDATES,
  );

  type Ahead = {
    readonly startAt: number;
    readonly requested: number;
    readonly page: ReturnType<BacklogPageReader["boardIssueSignals"]>;
  };
  let ahead: Ahead[] = [];
  const read = (at: number, requested: number): Ahead => {
    const page = client.boardIssueSignals(boardId, {
      jql,
      startAt: at,
      maxResults: requested,
    });
    // A page read ahead and never reached is not a failure of the scan.
    page.catch(() => {});
    return { startAt: at, requested, page };
  };

  while (selected.length < cap && candidatesScanned < scanLimit) {
    const requested = Math.min(PAGE_SIZE, scanLimit - candidatesScanned);
    const next = ahead.shift();
    const page = await (
      next !== undefined &&
      next.startAt === startAt &&
      next.requested === requested
        ? next
        : read(startAt, requested)
    ).page;

    if (knownTotal === undefined && page.total !== undefined) {
      knownTotal = page.total;
    }
    if (page.issues.length === 0) {
      exhausted = true;
      break;
    }

    // Offset by what Jira actually returned. Some sites cap below the request.
    startAt += page.issues.length;
    candidatesScanned += page.issues.length;

    // The pages after this one, asked for while it is read, on a board
    // with no ticket cap: one with a cap stops where it is met, and a page
    // read past it is a Jira call for tickets it drops. A short page ends
    // the scan below, so a full one says where the next begins.
    if (page.issues.length < requested) ahead = [];
    else if (knownTotal !== undefined && cap === Number.POSITIVE_INFINITY) {
      const last = ahead.at(-1);
      let at = last === undefined ? startAt : last.startAt + last.requested;
      while (
        ahead.length < LOOKAHEAD_PAGES &&
        at < knownTotal &&
        at - startAt + candidatesScanned < scanLimit
      ) {
        const more = Math.min(
          PAGE_SIZE,
          scanLimit - (at - startAt + candidatesScanned),
        );
        ahead.push(read(at, more));
        at += more;
      }
    }

    const fitting: SelectedIssue[] = [];
    for (const issue of page.issues) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      if ((issue.subtaskCount ?? 0) > 0) {
        skippedParents += 1;
        continue;
      }
      const matches = classify(factsFor(issue, now));
      if (matches.length === 0) {
        unmatched += 1;
        unfitting.push(issue);
        continue;
      }
      for (const { id } of matches) {
        matched[id] = (matched[id] ?? 0) + 1;
      }
      fitting.push({ ...issue, categories: matches });
    }

    // Asked only about the tickets that fit: a live proposal on a ticket the
    // run would not have picked is nothing to skip.
    const live =
      proposals === undefined || fitting.length === 0
        ? new Set<string>()
        : await proposals.liveExternalIds(
            organizationId,
            board.id,
            fitting.map((issue) => issue.id),
          );

    for (const issue of fitting) {
      if (live.has(issue.id)) {
        skippedLive += 1;
      } else if (selected.length < cap) {
        selected.push(issue);
      } else {
        capped = true;
      }
    }

    if (
      (knownTotal !== undefined && startAt >= knownTotal) ||
      page.issues.length < requested
    ) {
      exhausted = true;
      break;
    }
  }

  // Before the fallback, which takes tickets only when the cap took none.
  const ticketCapReached = capped || (!exhausted && selected.length >= cap);

  /*
    The fallback: nothing was taken by category, so the oldest tickets that
    fit none are taken instead. Asked about in pages, oldest first, so a
    board whose oldest tickets are already proposed still yields its next
    oldest, and the proposal store is never handed the whole scan at once.
  */
  const fallbackLimit = Math.min(selection.fallbackOldest, cap);
  let fallback = false;
  if (selected.length === 0 && fallbackLimit > 0) {
    for (
      let from = 0;
      from < unfitting.length && selected.length < fallbackLimit;
      from += PAGE_SIZE
    ) {
      const chunk = unfitting.slice(from, from + PAGE_SIZE);
      const live =
        proposals === undefined
          ? new Set<string>()
          : await proposals.liveExternalIds(
              organizationId,
              board.id,
              chunk.map((issue) => issue.id),
            );
      for (const issue of chunk) {
        if (selected.length >= fallbackLimit) break;
        if (!live.has(issue.id)) selected.push({ ...issue, categories: [] });
      }
    }
    fallback = selected.length > 0;
  }

  return {
    jql,
    selection,
    categories,
    issues: selected,
    matched,
    unmatched,
    candidatesScanned,
    skippedLive,
    skippedParents,
    scanLimitReached: !exhausted && candidatesScanned >= scanLimit,
    // Either a fitting ticket was turned away, or the cap was met with the
    // board unfinished and whatever remained unread.
    ticketCapReached,
    fallback,
    ...(knownTotal === undefined ? {} : { total: knownTotal }),
  };
}

export class InvalidBoardIdError extends Error {
  constructor() {
    super("That board has an unusable id.");
    this.name = "InvalidBoardIdError";
  }
}

/**
 * The number Jira's Agile API knows a board by. Stored as text, as Jira
 * sends it; one that is not a whole number cannot be asked about, and
 * reading it as `NaN` would send Jira a request for a board called "NaN".
 */
export function externalBoardId(board: { readonly externalId: string }) {
  const id = Number(board.externalId);
  if (!Number.isInteger(id)) throw new InvalidBoardIdError();
  return id;
}
