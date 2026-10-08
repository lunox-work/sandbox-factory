/**
 * A board's backlog scan, imported as bounties: each ticket the scan puts in
 * a category becomes a bounty whose overview is the ticket's text, with its
 * Jira fields kept as the overview's Jira context, and nothing else. No
 * proposal is made and no sandbox: those are the bounty's next steps, taken
 * on its page when someone asks. Nothing here calls a model, so a connected
 * board fills the bounty list for free.
 *
 * An issue already imported is read again: its text refreshes the overview
 * as any read of it does (a new overview version only when the words
 * changed), its fields are a new context version only when they changed,
 * and its categories are what this scan says. One issue can be imported
 * alone too, as a person picks it from a search of the board.
 *
 * - `POST .../jira/boards/:id/import` imports the board's scan, or with
 *   `issueId` that one issue. Any member may, as any member may write a
 *   bounty: it costs Jira reads, never a model call.
 */

import type {
  BountyContextStore,
  BountyStore,
  JiraBoardStore,
  JiraIssueStore,
} from "@sandbox-factory/db";
import { JiraApiError, JiraAuthError } from "@sandbox-factory/jira";
import {
  boardSelectionSchema,
  jiraImportRequestSchema,
  jiraImportResponseSchema,
  type JiraIssueSignalsDto,
} from "@sandbox-factory/shared";
import type { Hono } from "hono";
import {
  createClassifier,
  factsFor,
  type CategoryMatch,
  type JiraContext,
} from "sandbox-factory";

import type { RunClientResult, RunJiraClient } from "../pricing/executor.js";
import { mapConcurrent } from "../pricing/review.js";
import {
  externalBoardId,
  InvalidBoardIdError,
  selectBacklog,
} from "../pricing/selection.js";
import { jiraContextVersion } from "./context.js";

export interface BountyImportOptions {
  readonly boards: Pick<JiraBoardStore, "forRun">;
  readonly issues: Pick<JiraIssueStore, "upsert" | "bountiesFor">;
  readonly bounties: Pick<BountyStore, "categorize">;
  readonly contexts: Pick<BountyContextStore, "record">;
  readonly clientFor: (
    organizationId: string,
    connectionId: string,
  ) => Promise<RunClientResult>;
  readonly now?: () => Date;
}

/**
 * The most bounties one import makes or refreshes. A board's scan can find
 * thousands; each costs two Jira reads, so an import takes the first this
 * many the scan selects, oldest first, and the next import the same.
 */
export const IMPORT_LIMIT = 100;

/** Issues read from Jira at once. */
const IMPORT_CONCURRENCY = 4;

export type ImportResult =
  | {
      readonly ok: true;
      readonly created: number;
      readonly refreshed: number;
      readonly failed: number;
      /** The bounty a single issue's import made or refreshed. */
      readonly bountyId?: string;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422 | 502;
      readonly code: string;
      readonly error: string;
    };

const refused = (
  status: 404 | 409 | 422 | 502,
  code: string,
  error: string,
): ImportResult => ({ ok: false, status, code, error });

const RECONNECT = refused(
  409,
  "reconnect",
  "This Jira connection needs reconnecting.",
);

function needsReconnect(error: unknown): boolean {
  return (
    (error instanceof JiraAuthError && error.needsReconnect) ||
    (error instanceof JiraApiError && error.isUnauthorized)
  );
}

/**
 * Imports one issue: its text as the bounty's overview, its fields as the
 * overview's Jira context, its categories on the bounty. Null when Jira
 * could not be read for it, or the board has gone.
 */
async function importIssue(
  options: BountyImportOptions,
  organizationId: string,
  boardId: string,
  client: RunJiraClient,
  issue: { readonly id: string; readonly key: string },
  categories: readonly CategoryMatch[],
): Promise<string | null> {
  let spec: Awaited<ReturnType<RunJiraClient["issueSpec"]>>;
  let context: JiraContext;
  try {
    [spec, context] = await Promise.all([
      client.issueSpec(issue.id),
      client.issueContext(issue.id),
    ]);
  } catch (error) {
    if (needsReconnect(error)) throw error;
    return null;
  }
  const pointer = await options.issues.upsert(
    organizationId,
    boardId,
    { externalId: issue.id, key: issue.key },
    {
      title: spec.summary,
      description: spec.descriptionText,
      components: spec.components,
      inputTruncated: spec.inputTruncated,
    },
  );
  if (pointer === null) return null;
  await options.contexts.record(
    organizationId,
    pointer.bountyId,
    jiraContextVersion(
      { key: pointer.key, externalId: pointer.externalId },
      context,
      spec,
    ),
    // Nobody synced it: the import did.
    null,
  );
  await options.bounties.categorize(
    organizationId,
    pointer.bountyId,
    categories,
  );
  return pointer.bountyId;
}

/**
 * Imports what the board's scan selects, up to `IMPORT_LIMIT`: only the
 * tickets it puts in a category. The scan's fallback (the oldest tickets
 * when none fit one) is a suggestion of what to size, not a category, so
 * it is not imported.
 */
export async function importBoard(
  options: BountyImportOptions,
  organizationId: string,
  boardId: string,
): Promise<ImportResult> {
  const registered = await options.boards.forRun(organizationId, boardId);
  if (registered === null) return refused(404, "not_found", "Not found");
  const ready = await options.clientFor(
    organizationId,
    registered.connectionId,
  );
  if (!ready.ok) {
    return ready.reason === "not-found"
      ? refused(404, "not_found", "Not found")
      : RECONNECT;
  }
  const client = ready.client;
  try {
    const scan = await selectBacklog({
      organizationId,
      board: registered.board,
      client,
      ...(options.now === undefined ? {} : { now: options.now() }),
    });
    const chosen = scan.fallback
      ? []
      : scan.issues
          .filter((issue) => issue.categories.length > 0)
          .slice(0, IMPORT_LIMIT);
    const known = await options.issues.bountiesFor(
      organizationId,
      boardId,
      chosen.map(({ id }) => id),
    );
    const imported = await mapConcurrent(chosen, IMPORT_CONCURRENCY, (issue) =>
      importIssue(
        options,
        organizationId,
        boardId,
        client,
        issue,
        issue.categories,
      ),
    );
    let created = 0;
    let refreshed = 0;
    let failed = 0;
    imported.forEach((bountyId, index) => {
      const issue = chosen[index];
      if (bountyId === null || issue === undefined) failed += 1;
      else if (known.has(issue.id)) refreshed += 1;
      else created += 1;
    });
    return { ok: true, created, refreshed, failed };
  } catch (error) {
    if (error instanceof InvalidBoardIdError) {
      return refused(422, "invalid_board", error.message);
    }
    return needsReconnect(error)
      ? RECONNECT
      : refused(502, "jira_failed", "Jira could not be read.");
  }
}

/**
 * Imports one issue on the board, as a person picked it: classified as the
 * board's scan would, so it lands in the categories it fits, or in none.
 * Read through the board, so an issue another board shows cannot be
 * imported onto this one. One split into sub-tasks is not a bounty: its
 * sub-tasks are.
 */
export async function importBoardIssue(
  options: BountyImportOptions,
  organizationId: string,
  boardId: string,
  issueId: string,
): Promise<ImportResult> {
  const registered = await options.boards.forRun(organizationId, boardId);
  if (registered === null) return refused(404, "not_found", "Not found");
  const ready = await options.clientFor(
    organizationId,
    registered.connectionId,
  );
  if (!ready.ok) {
    return ready.reason === "not-found"
      ? refused(404, "not_found", "Not found")
      : RECONNECT;
  }
  const client = ready.client;
  try {
    let issue: JiraIssueSignalsDto | undefined;
    try {
      issue = (
        await client.boardIssueSignals(externalBoardId(registered.board), {
          jql: `issue = ${issueId}`,
          startAt: 0,
          maxResults: 1,
        })
      ).issues[0];
    } catch (error) {
      // Jira answers 400 for an issue id that does not exist.
      if (!(error instanceof JiraApiError && error.status === 400)) throw error;
    }
    if (issue === undefined) {
      return refused(
        404,
        "issue_not_found",
        "That issue is not on this board.",
      );
    }
    if ((issue.subtaskCount ?? 0) > 0) {
      return refused(
        409,
        "has_subtasks",
        "This issue is split into sub-tasks. Add those instead.",
      );
    }
    const selection = boardSelectionSchema.parse(registered.board.selection);
    const categories = createClassifier(selection.categories)(
      factsFor(issue, options.now?.() ?? new Date()),
    );
    const known = await options.issues.bountiesFor(organizationId, boardId, [
      issue.id,
    ]);
    const bountyId = await importIssue(
      options,
      organizationId,
      boardId,
      client,
      issue,
      categories,
    );
    if (bountyId === null) {
      return refused(502, "jira_failed", "Jira could not be read.");
    }
    const existed = known.has(issue.id);
    return {
      ok: true,
      created: existed ? 0 : 1,
      refreshed: existed ? 1 : 0,
      failed: 0,
      bountyId,
    };
  } catch (error) {
    if (error instanceof InvalidBoardIdError) {
      return refused(422, "invalid_board", error.message);
    }
    return needsReconnect(error)
      ? RECONNECT
      : refused(502, "jira_failed", "Jira could not be read.");
  }
}

/**
 * Imports every board named, one after another, for a sync that has just
 * registered or refreshed them. Run in the background: a failure is the
 * board's to show when its import is asked for again, never the sync's.
 */
export async function importBoards(
  options: BountyImportOptions,
  organizationId: string,
  boardIds: readonly string[],
): Promise<void> {
  for (const boardId of boardIds) {
    try {
      await importBoard(options, organizationId, boardId);
    } catch {
      // The next sync, or a person's import, tries again.
    }
  }
}

interface BountyImportAppEnv {
  Variables: {
    user: { id: string };
    member: { organizationId: string; role: string };
  };
}

export function mountBountyImportRoutes<Env extends BountyImportAppEnv>(
  app: Hono<Env>,
  options: BountyImportOptions,
): void {
  app.post("/api/v1/orgs/:orgId/jira/boards/:id/import", async (c) => {
    const { organizationId } = c.get("member");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = jiraImportRequestSchema.safeParse(raw ?? undefined);
    if (!parsed.success) {
      return c.json({ error: "Provide an issueId, or nothing." }, 400);
    }
    const boardId = c.req.param("id");
    const { issueId } = parsed.data;
    const result =
      issueId === undefined
        ? await importBoard(options, organizationId, boardId)
        : await importBoardIssue(options, organizationId, boardId, issueId);
    if (!result.ok) {
      return c.json({ code: result.code, error: result.error }, result.status);
    }
    const { ok: _ok, ...counts } = result;
    return c.json(jiraImportResponseSchema.parse(counts));
  });
}
