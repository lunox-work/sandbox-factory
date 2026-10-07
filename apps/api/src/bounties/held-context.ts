/**
 * The context a bounty holds from its sources, and how a sync's reading is
 * fingerprinted: shared by its detail, its sync routes, sizing and
 * generation, so each reads the same versions as held.
 */

import { createHash } from "node:crypto";

import type {
  BountyContextStore,
  JiraBoardStore,
  LatestBountyContext,
  StoredBounty,
} from "@sandbox-factory/db";
import type {
  ContextVersions,
  GithubContext,
  JiraContext,
} from "sandbox-factory";

/**
 * The repository a bounty's documents come from: its own, or, for a bounty
 * that names none and follows a Jira issue, its board's, as sizing drafts
 * beside.
 */
export async function contextRepoId(
  boards: Pick<JiraBoardStore, "forRun">,
  organizationId: string,
  bounty: Pick<StoredBounty, "repoId" | "jira">,
): Promise<string | null> {
  if (bounty.repoId !== null) return bounty.repoId;
  if (bounty.jira === null) return null;
  const board = await boards.forRun(organizationId, bounty.jira.boardId);
  return board?.board.sourceRepoId ?? null;
}

/**
 * The context a bounty holds: the latest version of each source, while it
 * was synced from the source the bounty is linked to now. One synced from
 * an issue or a repository since unlinked or replaced is not held: it
 * describes something the bounty is no longer about.
 */
export async function heldContext(
  options: {
    readonly contexts: Pick<BountyContextStore, "latest">;
    readonly boards: Pick<JiraBoardStore, "forRun">;
  },
  organizationId: string,
  bounty: Pick<StoredBounty, "id" | "repoId" | "jira">,
): Promise<LatestBountyContext> {
  const latest = await options.contexts.latest(organizationId, bounty.id);
  if (latest === null) return { jira: null, github: null };
  const issueId =
    bounty.jira === null || bounty.jira.removedAt !== null
      ? null
      : bounty.jira.externalId;
  const repoId =
    latest.github === null
      ? null
      : await contextRepoId(options.boards, organizationId, bounty);
  return {
    jira:
      latest.jira !== null && latest.jira.refId === issueId
        ? latest.jira
        : null,
    github:
      latest.github !== null && latest.github.refId === repoId
        ? latest.github
        : null,
  };
}

/** The versions held context stands at. */
export function contextVersionsOf(held: LatestBountyContext): ContextVersions {
  return {
    jira: held.jira?.version ?? null,
    github: held.github?.version ?? null,
  };
}

/**
 * The fingerprint a sync compares, of what the source says rather than
 * where it was read: Jira's `updated` and the repository's commit move
 * with edits a context does not hold, so they are left out of it and kept
 * as the version's revision instead.
 */
export function contextHash(
  context:
    | { readonly source: "jira"; readonly content: JiraContext }
    | { readonly source: "github"; readonly content: GithubContext },
): string {
  const said =
    context.source === "jira"
      ? { ...context.content, updated: null }
      : {
          fullName: context.content.fullName,
          documents: context.content.documents,
          omitted: context.content.omitted,
        };
  return createHash("sha256")
    .update(JSON.stringify([context.source, said]))
    .digest("hex");
}
