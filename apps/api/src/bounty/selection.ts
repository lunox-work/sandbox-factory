/**
 * Shared, read-only ticket selection for preview and bounty runs.
 *
 * A run does not take a fixed number of tickets. It reads every open ticket
 * on the board and keeps each one that fits at least one category in the
 * registry (`sandbox-factory`'s `CATEGORIES`), with the reason it fit. What
 * a category is, and what it looks for, is decided there and nowhere here:
 * this file pages, classifies, and leaves out tickets already proposed.
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

export interface BacklogPageReader {
  boardIssueSignals(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssueSignalsPageDto>;
}

/** A ticket a run will size, with why it was picked. */
export type SelectedIssue = JiraIssueSignalsDto & {
  /** Every category it fits, in registry order. Never empty. */
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
  /** The scan stopped at its ceiling with tickets on the board still unread. */
  readonly scanLimitReached: boolean;
  /** The board's `ticketCap` stopped the selection before the board ended. */
  readonly ticketCapReached: boolean;
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
  const externalBoardId = Number(board.externalId);
  if (!Number.isInteger(externalBoardId)) {
    throw new InvalidBoardIdError();
  }

  const categories = resolveCategories(selection.categories);
  const classify = createClassifier(selection.categories);
  const matched: Record<string, number> = Object.fromEntries(
    categories.filter(({ enabled }) => enabled).map(({ id }) => [id, 0]),
  );
  const cap = selection.ticketCap ?? Number.POSITIVE_INFINITY;

  const selected: SelectedIssue[] = [];
  const seen = new Set<string>();
  let startAt = 0;
  let candidatesScanned = 0;
  let skippedLive = 0;
  let unmatched = 0;
  let knownTotal: number | undefined;
  let exhausted = false;
  let capped = false;
  const scanLimit = Math.min(
    Math.max(options.scanLimit ?? MAX_SCAN_CANDIDATES, 1),
    MAX_SCAN_CANDIDATES,
  );

  while (selected.length < cap && candidatesScanned < scanLimit) {
    const requested = Math.min(PAGE_SIZE, scanLimit - candidatesScanned);
    const page = await client.boardIssueSignals(externalBoardId, {
      jql,
      startAt,
      maxResults: requested,
    });

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

    const fitting: SelectedIssue[] = [];
    for (const issue of page.issues) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      const matches = classify(factsFor(issue, now));
      if (matches.length === 0) {
        unmatched += 1;
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

  return {
    jql,
    selection,
    categories,
    issues: selected,
    matched,
    unmatched,
    candidatesScanned,
    skippedLive,
    scanLimitReached: !exhausted && candidatesScanned >= scanLimit,
    // Either a fitting ticket was turned away, or the cap was met with the
    // board unfinished and whatever remained unread.
    ticketCapReached: capped || (!exhausted && selected.length >= cap),
    ...(knownTotal === undefined ? {} : { total: knownTotal }),
  };
}

export class InvalidBoardIdError extends Error {
  constructor() {
    super("That board has an unusable id.");
    this.name = "InvalidBoardIdError";
  }
}
