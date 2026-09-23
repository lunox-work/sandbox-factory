/** Shared, read-only backlog selection for preview and bounty runs. */

import type {
  BountyProposalStore,
  JiraBoardSummary,
} from "@sandbox-factory/db";
import { backlogJql, backlogSource } from "@sandbox-factory/jira";
import {
  boardSelectionSchema,
  type BoardSelection,
  type JiraIssueDto,
  type JiraIssuePageDto,
} from "@sandbox-factory/shared";

const PAGE_SIZE = 100;
export const MAX_SCAN_CANDIDATES = 5_000;

export interface BacklogPageReader {
  backlogIssues(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssuePageDto>;
  boardIssues(
    boardId: number,
    options: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraIssuePageDto>;
}

export interface BacklogSelectionResult {
  readonly source: "backlog" | "board-issues";
  readonly jql: string;
  readonly selection: BoardSelection;
  readonly issues: JiraIssueDto[];
  readonly candidatesScanned: number;
  readonly skippedLive: number;
  readonly scanLimitReached: boolean;
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
 * Selects the first configured number of eligible issues across Jira pages.
 * It never writes pointers or runs and never reads issue descriptions.
 */
export async function selectBacklog(
  options: SelectBacklogOptions,
): Promise<BacklogSelectionResult> {
  const { organizationId, board, client, proposals } = options;
  const selection = boardSelectionSchema.parse(board.selection);
  const source = backlogSource(board.boardType);
  const jql = backlogJql(selection, {
    projectKey: board.projectKey ?? undefined,
    source,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const externalBoardId = Number(board.externalId);
  if (!Number.isInteger(externalBoardId)) {
    throw new InvalidBoardIdError();
  }

  const selected: JiraIssueDto[] = [];
  const seen = new Set<string>();
  let startAt = 0;
  let candidatesScanned = 0;
  let skippedLive = 0;
  let knownTotal: number | undefined;
  const scanLimit = Math.min(
    Math.max(options.scanLimit ?? MAX_SCAN_CANDIDATES, 1),
    MAX_SCAN_CANDIDATES,
  );

  while (
    selected.length < selection.maxTickets &&
    candidatesScanned < scanLimit
  ) {
    const requested = Math.min(PAGE_SIZE, scanLimit - candidatesScanned);
    const page =
      source === "backlog"
        ? await client.backlogIssues(externalBoardId, {
            jql,
            startAt,
            maxResults: requested,
          })
        : await client.boardIssues(externalBoardId, {
            jql,
            startAt,
            maxResults: requested,
          });

    if (knownTotal === undefined && page.total !== undefined) {
      knownTotal = page.total;
    }
    if (page.issues.length === 0) break;

    // Offset by what Jira actually returned. Some sites cap below the request.
    startAt += page.issues.length;
    candidatesScanned += page.issues.length;

    const fresh = page.issues.filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
    const live =
      proposals === undefined
        ? new Set<string>()
        : await proposals.liveExternalIds(
            organizationId,
            board.id,
            fresh.map((issue) => issue.id),
          );

    for (const issue of fresh) {
      if (live.has(issue.id)) {
        skippedLive += 1;
      } else if (selected.length < selection.maxTickets) {
        selected.push(issue);
      }
    }

    if (knownTotal !== undefined && startAt >= knownTotal) break;
    if (page.issues.length < requested) break;
  }

  return {
    source,
    jql,
    selection,
    issues: selected,
    candidatesScanned,
    skippedLive,
    scanLimitReached:
      candidatesScanned >= scanLimit &&
      selected.length < selection.maxTickets &&
      (knownTotal === undefined || startAt < knownTotal),
    ...(knownTotal === undefined ? {} : { total: knownTotal }),
  };
}

export class InvalidBoardIdError extends Error {
  constructor() {
    super("That board has an unusable id.");
    this.name = "InvalidBoardIdError";
  }
}
