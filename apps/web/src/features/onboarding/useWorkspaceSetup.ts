import { isWorkspaceSource } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { rankAtLeast } from "sandbox-factory";

import { clients, queryKeys, useUserId } from "../../data/query";
import { useGithub, useGithubRepos } from "../../useGithub";
import { useJira, useJiraBoards } from "../../useJira";
import type { SetupFacts } from "./setup";

/**
 * The facts `setup.ts` reasons about, read for one workspace.
 *
 * Every read here is one the pages it summarises already make, under the
 * same cache keys, so home costs nothing they would not: the Jira and GitHub
 * lists, the workspace's proposal counts and the first page of its bounties.
 * None of them reaches Jira or GitHub; they are the platform's own rows.
 *
 * `facts` is null until every read has answered once. Home shows nothing
 * rather than a stage it would change a moment later — a workspace with
 * Jira briefly drawn as one without would offer to connect what it has.
 * A read that failed counts as having nothing, and `failed` says so, so the
 * page is still usable and can offer to read again.
 */
export function useWorkspaceSetup(
  organization: { id: string; role: string } | null,
) {
  const userId = useUserId();
  const owner = organization?.id;
  const jira = useJira(owner);
  const boards = useJiraBoards(owner);
  const github = useGithub(owner);
  const repos = useGithubRepos(owner);
  // The same read the proposal list makes for the workspace's counts.
  const proposals = useQuery({
    queryKey: queryKeys.resource(
      userId,
      owner ?? "",
      "proposal-categories",
      undefined,
    ),
    enabled: owner !== undefined,
    queryFn: ({ signal }) =>
      clients.pricing.categories(owner ?? "", undefined, signal),
  });
  // Whether there is any bounty at all: one page of one is enough.
  const bounties = useQuery({
    queryKey: queryKeys.resource(userId, owner ?? "", "bounties", "any"),
    enabled: owner !== undefined,
    queryFn: ({ signal }) =>
      clients.bounties.bounties(owner ?? "", { limit: 1 }, signal),
  });

  const loading =
    owner === undefined ||
    jira.loading ||
    boards.loading ||
    github.loading ||
    repos.loading ||
    proposals.isPending ||
    bounties.isPending;

  const healthyJira = jira.connections.filter(({ healthy }) => healthy);
  const current: SetupFacts | null = loading
    ? null
    : {
        jira: {
          available: !jira.unconfigured,
          connected: healthyJira.length,
          broken: jira.connections.length - healthyJira.length,
          boards: boards.boards.length,
        },
        github: {
          available: !github.unconfigured,
          connected: github.connections.filter(({ healthy }) => healthy).length,
          repositories: repos.repos.filter(isWorkspaceSource).length,
        },
        proposals: proposals.data?.total ?? 0,
        bounties: bounties.data?.bounties.length ?? 0,
        canManage: rankAtLeast(organization?.role ?? "member", "admin"),
      };
  /*
    Once known, kept while any read goes again. A read that failed has no
    data, and reading it again puts it back to pending; without this the
    page would fall back to its loading line and unmount what it showed —
    and a component mounting again reads a failed query again, so the two
    would chase each other for as long as the read kept failing.
  */
  const known = useRef<{ owner: string; facts: SetupFacts } | null>(null);
  if (current !== null && owner !== undefined)
    known.current = { owner, facts: current };
  const facts = current ?? known.current?.facts ?? null;

  return {
    facts,
    /**
     * `facts` are this workspace's: read for it, now or before its reads
     * went again. False while they are still another's — the one switched
     * away from — or nobody's yet.
     */
    ownFacts: owner !== undefined && known.current?.owner === owner,
    failed:
      jira.error !== null ||
      github.error !== null ||
      // A server without the App refuses its repository list too, which is
      // the same "not offered here", not a failure.
      (repos.error !== null && !github.unconfigured) ||
      proposals.isError ||
      bounties.isError,
    /** Reads every fact again, after a failure or a change made elsewhere. */
    refresh: async () => {
      await Promise.all([
        jira.refresh(),
        boards.refresh(),
        github.refresh(),
        repos.refresh(),
        proposals.refetch(),
        bounties.refetch(),
      ]);
    },
    jira,
    boards,
    github,
    repos,
  };
}

export type WorkspaceSetup = ReturnType<typeof useWorkspaceSetup>;
