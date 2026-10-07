import { ApiError } from "@sandbox-factory/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clients, queryKeys, useOwnerQuery, useUserId } from "./data/query";
import { replaceLocation } from "./navigation/location";
/**
 * An organization's GitHub: the installations it has linked, and the
 * repositories registered from them.
 *
 * Connecting is not a `fetch`, as with Jira: it is a full-page navigation to
 * the API, which redirects to GitHub and eventually back here with
 * `?github=<outcome>`. Everything else is an ordinary JSON call.
 *
 * The shapes are the shared DTOs from `@sandbox-factory/shared`, the same
 * ones the API's tests parse its responses with, so the two cannot drift.
 */

import type {
  GithubConnectionDto,
  GithubConnectOutcome,
  GithubRepoDto,
  RepoSnapshotDetailDto,
} from "@sandbox-factory/shared";
import { GITHUB_CONNECT_OUTCOMES } from "@sandbox-factory/shared";
import { useCallback, useEffect, useState } from "react";

const base = (organizationId: string) =>
  `/api/v1/orgs/${encodeURIComponent(organizationId)}/github`;

/** The API's error body, read defensively. */
function failureOf(
  error: unknown,
  fallback: string,
): { ok: false; error: string; code?: string } {
  return {
    ok: false,
    error:
      error instanceof ApiError && error.status !== 404
        ? error.message
        : fallback,
    ...(error instanceof ApiError && error.code !== null
      ? { code: error.code }
      : {}),
  };
}

/**
 * A call's result. `code` is the API's, when it sent one, for the few a
 * caller acts on: `unhealthy` (the installation is gone on GitHub's side) and
 * `reconnect` (the person's own authorization lapsed).
 */
export type Result<T = undefined> =
  { ok: true; value: T } | { ok: false; error: string; code?: string };

export interface GithubConnections {
  connections: GithubConnectionDto[];
  loading: boolean;
  error: string | null;
  /**
   * The server has no GitHub App configured. Not an error: the tool is
   * simply not offered here, and the page says so instead of failing.
   */
  unconfigured: boolean;
  /** Sends the browser to GitHub. Does not return. */
  connect: () => void;
  disconnect: (connectionId: string) => Promise<Result>;
  refresh: () => Promise<void>;
}

export function useGithub(
  organizationId: string | undefined,
): GithubConnections {
  const cache = useQueryClient();
  const userId = useUserId();
  const query = useOwnerQuery(
    organizationId,
    "github-connections",
    (owner, signal) => clients.github.connections(owner, signal),
  );
  const unconfigured =
    query.error instanceof ApiError && query.error.code === "unconfigured";
  const state = {
    connections: query.data ?? [],
    loading: organizationId !== undefined && query.isPending,
    error:
      query.isError && !unconfigured
        ? "Could not load your GitHub connections."
        : null,
    unconfigured,
  };
  // A connection linked or dropped changes which are left to link.
  const refresh = useCallback(async () => {
    await Promise.all([
      query.refresh(),
      cache.invalidateQueries({
        queryKey: queryKeys.resource(
          userId,
          organizationId ?? "",
          "github-available",
        ),
      }),
    ]);
  }, [query.refresh, cache, userId, organizationId]);

  const connect = useCallback(() => {
    if (organizationId === undefined) return;
    // A full-page navigation: the browser has to reach GitHub, and an XHR
    // would fail CORS following the redirect there.
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `${base(organizationId)}/connect?${new URLSearchParams(
      { returnTo },
    ).toString()}`;
  }, [organizationId]);

  const disconnect = useCallback(
    async (connectionId: string): Promise<Result> => {
      if (organizationId === undefined) {
        return { ok: false, error: "Could not disconnect that account." };
      }
      try {
        await clients.github.disconnect(organizationId, connectionId);
        await cache.invalidateQueries({
          queryKey: queryKeys.resource(
            userId,
            organizationId,
            "github-repositories",
          ),
        });
        await refresh();
        return { ok: true, value: undefined };
      } catch (error) {
        return failureOf(
          error,
          error instanceof ApiError
            ? "Could not disconnect that account."
            : "Could not reach the server. The account is still connected.",
        );
      }
    },
    [organizationId, refresh, cache, userId],
  );

  return { ...state, connect, disconnect, refresh };
}

/**
 * Reads the outcome the callback appended, and removes it from the URL, so
 * a reload does not announce it again and a shared link does not carry it.
 */
export function useGithubOutcome(): {
  outcome: GithubConnectOutcome | null;
  dismiss: () => void;
} {
  const [outcome, setOutcome] = useState<GithubConnectOutcome | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("github");
    if (value === null) return;
    // An unknown value reads as a failure rather than as nothing: something
    // came back, and the person should hear that it did not work.
    setOutcome(
      GITHUB_CONNECT_OUTCOMES.find((known) => known === value) ?? "error",
    );
    params.delete("github");
    const query = params.toString();
    replaceLocation(
      window.location.pathname +
        (query === "" ? "" : `?${query}`) +
        (window.location.hash ?? ""),
    );
  }, []);

  return {
    outcome,
    dismiss: useCallback(() => setOutcome(null), []),
  };
}

export async function linkInstallation(
  organizationId: string,
  installationId: string,
): Promise<Result> {
  try {
    await clients.github.link(organizationId, installationId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failureOf(error, "Could not connect that installation.");
  }
}
export interface GithubRepos {
  repos: GithubRepoDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  register: (connectionId: string, externalId: string) => Promise<Result>;
  remove: (repoId: string) => Promise<Result>;
}

/** The organization's registered repositories. */
export function useGithubRepos(
  organizationId: string | undefined,
): GithubRepos {
  const cache = useQueryClient();
  const userId = useUserId();
  const query = useOwnerQuery(
    organizationId,
    "github-repositories",
    (owner, signal) => clients.github.repositories(owner, signal),
  );
  const state = {
    repos: query.data ?? [],
    loading: organizationId !== undefined && query.isPending,
    error: query.isError ? "Could not load the registered repositories." : null,
  };
  const refresh = useCallback(async () => {
    await query.refresh();
  }, [query.refresh]);

  const register = useCallback(
    async (connectionId: string, externalId: string): Promise<Result> => {
      if (organizationId === undefined) {
        return { ok: false, error: "Could not register that repository." };
      }
      try {
        await clients.github.register(organizationId, connectionId, externalId);
        await refresh();
        return { ok: true, value: undefined };
      } catch (error) {
        return failureOf(error, "Could not reach the server.");
      }
    },
    [organizationId, refresh],
  );

  const remove = useCallback(
    async (repoId: string): Promise<Result> => {
      if (organizationId === undefined) {
        return { ok: false, error: "Could not remove that repository." };
      }
      try {
        await clients.github.remove(organizationId, repoId);
        await Promise.all([
          refresh(),
          // It can be registered again, and the bounties linked to it lose
          // the link.
          ...[
            "github-installation-repositories",
            "bounties",
            "bounty-detail",
          ].map((resource) =>
            cache.invalidateQueries({
              queryKey: queryKeys.resource(userId, organizationId, resource),
            }),
          ),
          cache.invalidateQueries({
            queryKey: queryKeys.me(userId, "bounties"),
          }),
        ]);
        return { ok: true, value: undefined };
      } catch (error) {
        return failureOf(error, "Could not reach the server.");
      }
    },
    [organizationId, refresh, cache, userId],
  );

  return { ...state, refresh, register, remove };
}

/**
 * One repository snapshot, for a line that names the commit something was
 * read at. Null while it loads, and when it cannot be read — gone, pruned,
 * or GitHub not set up here — since every caller has something to show
 * without it.
 */
export function useRepoSnapshot(
  /** The organization's API root, `/api/v1/orgs/<id>`. */
  organizationBase: string,
  snapshotId: string | null,
): RepoSnapshotDetailDto | null {
  const owner = decodeURIComponent(organizationBase.split("/").at(-1) ?? "");
  const userId = useUserId();
  const query = useQuery({
    queryKey: queryKeys.resource(userId, owner, "snapshot", snapshotId),
    enabled: snapshotId !== null,
    queryFn: ({ signal }) =>
      clients.analysis.snapshot(owner, snapshotId ?? "", signal),
  });
  return query.data ?? null;
}
