import { ApiError } from "@sandbox-factory/client";
import { useQueries, useQueryClient } from "@tanstack/react-query";
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
  /**
   * Sends the browser to GitHub. Does not return. `install` goes to the
   * App's install page rather than the authorize URL, for when the person
   * has seen that nothing GitHub lists them can be linked here.
   */
  connect: (options?: { install?: boolean }) => void;
  disconnect: (connectionId: string) => Promise<Result>;
  refresh: () => Promise<void>;
  /**
   * Lists a connection the API has just answered with, ahead of reading the
   * list again, so the page never shows it missing in between.
   */
  listed: (connection: GithubConnectionDto) => void;
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
  // A connection linked or dropped changes which are left to link. That list
  // is not waited for: only an open picker shows it, it is the one read that
  // goes to GitHub, and the page is waiting on its own list, not the picker's.
  const refresh = useCallback(async () => {
    void cache.invalidateQueries({
      queryKey: queryKeys.resource(
        userId,
        organizationId ?? "",
        "github-available",
      ),
    });
    await query.refresh();
  }, [query.refresh, cache, userId, organizationId]);

  const connect = useCallback(
    (options?: { install?: boolean }) => {
      if (organizationId === undefined) return;
      // A full-page navigation: the browser has to reach GitHub, and an XHR
      // would fail CORS following the redirect there.
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `${base(organizationId)}/connect?${new URLSearchParams(
        {
          returnTo,
          ...(options?.install === true ? { install: "1" } : {}),
        },
      ).toString()}`;
    },
    [organizationId],
  );

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

  const { setData } = query;
  const listed = useCallback(
    (connection: GithubConnectionDto) => {
      setData((current) => [
        ...(current ?? []).filter((entry) => entry.id !== connection.id),
        connection,
      ]);
    },
    [setData],
  );

  return { ...state, connect, disconnect, refresh, listed };
}

/**
 * Reads the outcome the callback appended, and removes it from the URL, so
 * a reload does not announce it again and a shared link does not carry it.
 */
export function useGithubOutcome(): {
  outcome: GithubConnectOutcome | null;
  dismiss: () => void;
  /** Shows an outcome reached here rather than on the way back from GitHub. */
  announce: (outcome: GithubConnectOutcome) => void;
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
    announce: setOutcome,
  };
}

export async function linkInstallation(
  organizationId: string,
  installationId: string,
): Promise<Result<GithubConnectionDto>> {
  try {
    return {
      ok: true,
      value: await clients.github.link(organizationId, installationId),
    };
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
 * Repository snapshots, for a line that names the commit each was read at,
 * in the order named: each once it has answered, and null for one that
 * cannot be read — gone, pruned, or GitHub not set up here — so a caller
 * can say one is missing rather than name fewer than there are.
 */
export function useRepoSnapshots(
  /** The organization's API root, `/api/v1/orgs/<id>`. */
  organizationBase: string,
  snapshotIds: readonly string[],
): (RepoSnapshotDetailDto | null)[] {
  const owner = decodeURIComponent(organizationBase.split("/").at(-1) ?? "");
  const userId = useUserId();
  return useQueries({
    queries: snapshotIds.map((snapshotId) => ({
      queryKey: queryKeys.resource(userId, owner, "snapshot", snapshotId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        clients.analysis.snapshot(owner, snapshotId, signal),
    })),
  }).flatMap(({ data, isError }) =>
    data !== undefined ? [data] : isError ? [null] : [],
  );
}
