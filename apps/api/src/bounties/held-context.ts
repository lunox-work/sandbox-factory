/**
 * The context a bounty holds from its sources, and how a sync's reading is
 * fingerprinted: shared by its detail, its sync routes, sizing and
 * generation, so each reads the same versions as held.
 */

import { createHash } from "node:crypto";

import { isWorkspaceSource } from "@sandbox-factory/shared";

import type {
  BountyContextStore,
  GithubRepoSummary,
  LatestBountyContext,
  StoredBounty,
  StoredBountyContext,
} from "@sandbox-factory/db";
import {
  githubRepositories,
  type ContextVersions,
  type GithubContext,
  type JiraContext,
} from "sandbox-factory";

/**
 * What a GitHub context version is named by. A bounty names no
 * repository, so its documents are the workspace's: every version synced
 * since is this one source, whichever repositories it read.
 */
export const WORKSPACE_REPOSITORIES = "workspace";

/**
 * The repositories a bounty's work may touch: every one the workspace has
 * connected as a source and GitHub still answers for, in name order.
 */
export async function connectedRepositories(
  repos: {
    list(organizationId: string): Promise<readonly GithubRepoSummary[]>;
  },
  organizationId: string,
): Promise<GithubRepoSummary[]> {
  return (await repos.list(organizationId)).filter(isWorkspaceSource);
}

/**
 * Where the workspace's repositories stood when their documents were read:
 * each one's full name and commit, in name order. A sync whose repositories
 * now stand elsewhere, or which reads a different set, is behind.
 */
export function repositoriesRevision(
  read: readonly { readonly fullName: string; readonly commitSha: string }[],
): string {
  return read
    .map(({ fullName, commitSha }) => `${fullName}@${commitSha}`)
    .sort()
    .join("\n");
}

/**
 * Each repository's commit in a GitHub version's revision, by full name:
 * the commit the scope holds it at. A pick that read the same documents
 * makes no new version but moves its revision, so this, not the content,
 * says where each one is held.
 */
export function revisionCommits(revision: string): Map<string, string> {
  return new Map(
    revision.split("\n").flatMap((line): [string, string][] => {
      const at = line.lastIndexOf("@");
      return at <= 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]];
    }),
  );
}

/**
 * Each repository's commit in the GitHub version a scope holds, by full
 * name; none for no version, or one synced while a bounty named one
 * repository, which is not the workspace's.
 */
export function heldCommits(
  github: Pick<StoredBountyContext, "refId" | "revision"> | null | undefined,
): Map<string, string> {
  return github == null || github.refId !== WORKSPACE_REPOSITORIES
    ? new Map()
    : revisionCommits(github.revision);
}

/**
 * The built snapshot a repository is read at when none is picked: the one
 * of the commit the scope holds it at while that is still built, else its
 * newest build. A repository never built has none, and is neither read nor
 * outlined, so sizing cannot name it.
 */
export function builtAt<T extends { readonly commitSha: string }>(
  built: readonly T[],
  heldSha: string | undefined,
): T | null {
  return (
    built.find(({ commitSha }) => commitSha === heldSha) ?? built[0] ?? null
  );
}

/**
 * The context a bounty holds: the latest version of each source. Jira's
 * is held while it was synced from the issue the bounty follows now; one
 * from an issue since unlinked or replaced describes something the bounty
 * is no longer about. GitHub's is the workspace's repositories', whichever
 * the bounty is about, so its latest is always held.
 */
export async function heldContext(
  options: { readonly contexts: Pick<BountyContextStore, "latest"> },
  organizationId: string,
  bounty: Pick<StoredBounty, "id" | "jira">,
): Promise<LatestBountyContext> {
  const latest = await options.contexts.latest(organizationId, bounty.id);
  if (latest === null) return { jira: null, github: null };
  const issueId =
    bounty.jira === null || bounty.jira.removedAt !== null
      ? null
      : bounty.jira.externalId;
  return {
    jira:
      latest.jira !== null && latest.jira.refId === issueId
        ? latest.jira
        : null,
    github: latest.github,
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
 * as the version's revision instead. A context kept in the one-repository
 * shape hashes as the workspace's with that one repository, and the
 * workspace's unread repositories are left out, as they say nothing.
 */
export function contextHash(
  context:
    | { readonly source: "jira"; readonly content: JiraContext }
    | { readonly source: "github"; readonly content: GithubContext },
): string {
  const said =
    context.source === "jira"
      ? { ...context.content, updated: null }
      : githubRepositories(context.content).map(
          ({ fullName, documents, omitted }) => ({
            fullName,
            documents,
            omitted,
          }),
        );
  return createHash("sha256")
    .update(JSON.stringify([context.source, said]))
    .digest("hex");
}
