import { ApiError } from "@sandbox-factory/client";
import { useQueryClient } from "@tanstack/react-query";
import { clients, queryKeys, useOwnerQuery, useUserId } from "./data/query";
import { replaceLocation } from "./navigation/location";
/**
 * The Jira sites an organization has connected.
 *
 * Connecting is not a `fetch`: it is a full-page navigation to the API, which
 * redirects to Atlassian and eventually back here. That is why `connect` sets
 * `window.location` rather than returning a promise — an XHR would follow the
 * redirect to Atlassian's consent screen and fail CORS, and the user needs to
 * *see* that screen to grant anything.
 */

import { useCallback, useEffect, useState } from "react";

/** A connected site, as the API reports it. Carries no token material. */
export interface JiraConnection {
  id: string;
  cloudId: string;
  siteUrl: string;
  siteName: string;
  email: string | null;
  healthy: boolean;
  scopes: string[];
  resourceScopes: string[];
  /**
   * Whether approvals on this site's boards post back to the ticket. The
   * API derives it from the grant; every consent asks for the write scope,
   * so it is false only for a site connected before that was so, or one
   * whose admin withheld it. Connecting the site again is the remedy.
   */
  writeGranted: boolean;
  createdAt: string;
}

/**
 * What the callback reports back through the query string.
 *
 * Every value is a state the user can act on, which is why a failed connection
 * ends here rather than as an error page: `cancelled` and `no-sites` are not
 * faults at all, and the other two have different remedies.
 */
/**
 * A Jira list read as empty where the API has no Jira: a server without its
 * Atlassian app mounts no Jira routes, so the list is a 404. That is a
 * deployment without Jira, which the product works without, not a failure
 * to show on every page that lists sites or boards.
 */
export async function withoutJira<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return [];
    throw error;
  }
}

export const JIRA_OUTCOMES = [
  "connected",
  "cancelled",
  "denied",
  "no-sites",
  "partial-scopes",
  "state",
  "forbidden",
  "error",
] as const;
export type JiraOutcome = (typeof JIRA_OUTCOMES)[number];

export interface JiraState {
  connections: JiraConnection[];
  loading: boolean;
  error: string | null;
}

export interface Jira extends JiraState {
  /** Sends the browser to Atlassian. Does not return. */
  connect: () => void;
  disconnect: (
    connectionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  refresh: () => Promise<void>;
}

export function useJira(organizationId: string | undefined): Jira {
  const cache = useQueryClient();
  const userId = useUserId();
  const query = useOwnerQuery(
    organizationId,
    "jira-connections",
    (owner, signal) => withoutJira(clients.jira.connections(owner, signal)),
  );
  const [writeError, setWriteError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    await query.refresh();
    setWriteError(null);
  }, [query.refresh]);
  const state: JiraState = {
    connections: query.data ?? [],
    loading: organizationId !== undefined && query.isPending,
    error:
      writeError ??
      (query.isError ? "Could not load your Jira connections." : null),
  };

  /**
   * Connect a site, or connect one again.
   *
   * The same call for both: a consent is recorded against the site it names,
   * so re-consenting to a connected site refreshes that connection — which
   * is also how a site connected read-only comes to hold the write grant.
   */
  const connect = useCallback(() => {
    if (organizationId === undefined) {
      return;
    }
    // A full-page navigation, not a fetch: the browser has to reach
    // Atlassian's consent screen, and an XHR would fail CORS trying.
    const returnTo = window.location.pathname + window.location.search;
    const query = new URLSearchParams({ returnTo });
    window.location.href = `/api/v1/orgs/${encodeURIComponent(
      organizationId,
    )}/jira/connect?${query.toString()}`;
  }, [organizationId]);

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (organizationId === undefined) {
        return { ok: false as const, error: "Could not disconnect that site." };
      }
      try {
        await clients.jira.disconnect(organizationId, connectionId);
        await cache.invalidateQueries({
          queryKey: queryKeys.resource(userId, organizationId, "jira-boards"),
        });
        await refresh();
        return { ok: true as const };
      } catch (caught) {
        const error =
          caught instanceof ApiError
            ? "Could not disconnect that site."
            : "Could not reach the server. The site is still connected.";
        setWriteError(error);
        return { ok: false as const, error };
      }
    },
    [organizationId, refresh, cache, userId],
  );

  return { ...state, connect, disconnect, refresh };
}

/**
 * Reads the outcome the callback appended, and removes it from the URL.
 *
 * Removed because it is a one-time message: a reload should not re-announce
 * "connected", and a shared link should not carry someone else's outcome.
 */
export function useJiraOutcome(): {
  outcome: JiraOutcome | null;
  missingScopes: string[];
  dismiss: () => void;
} {
  const [outcome, setOutcome] = useState<JiraOutcome | null>(null);
  const [missingScopes, setMissingScopes] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("jira");
    if (value === null) {
      return;
    }
    // Anything else in the query is not an outcome the callback sends, and
    // would render as an empty notice; it is only cleared.
    const known = JIRA_OUTCOMES.find((outcome) => outcome === value);
    if (known !== undefined) setOutcome(known);
    const missing = params.get("missing");
    setMissingScopes(
      known === undefined || missing === null || missing === ""
        ? []
        : missing.split(","),
    );

    // Strip both, so a reload does not repeat the message.
    params.delete("jira");
    params.delete("missing");
    const query = params.toString();
    replaceLocation(
      window.location.pathname +
        (query === "" ? "" : `?${query}`) +
        (window.location.hash ?? ""),
    );
  }, []);

  return {
    outcome,
    missingScopes,
    dismiss: useCallback(() => {
      setOutcome(null);
    }, []),
  };
}

/* -------------------------------------------------------------------------- */
/* Boards                                                                     */
/* -------------------------------------------------------------------------- */

/** A board this organization has registered, with its settings. */
export interface JiraBoard {
  id: string;
  connectionId: string;
  externalId: string;
  name: string;
  boardType: string;
  projectKey: string | null;
  selection: Partial<import("@sandbox-factory/shared").BoardSelection>;
  /**
   * The registered GitHub repository the board's tickets are about. Absent
   * from a server older than repository links, which reads as unlinked.
   */
  sourceRepoId?: string | null;
  createdAt: string;
}

/** Why a run picks a ticket: one category it fits, and the case for it. */
export interface JiraCategoryMatch {
  id: string;
  label: string;
  reason: string;
}

/** A ticket as a board lists it. The same DTO a run will price. */
export interface JiraPreviewIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  assignee: string | null;
  issueType: string;
  created: string | null;
  updated: string | null;
  url: string | null;
  /** Every category the ticket fits, when the read classified it. */
  categories?: JiraCategoryMatch[];
}

/** One ticket in full, as the detail view shows it. */
export interface JiraIssueDetail extends JiraPreviewIssue {
  descriptionText: string;
  reporter: string | null;
  creator: string | null;
  resolution: string | null;
  resolutionDate: string | null;
  labels: string[];
  priority: string | null;
  parentKey: string | null;
  projectKey: string | null;
  dueDate: string | null;
  components: string[];
  fixVersions: string[];
  originalEstimateSeconds: number | null;
  remainingEstimateSeconds: number | null;
  votes: number | null;
  watchers: number | null;
  environment: string | null;
}

/**
 * Why a Jira read failed, in the terms the page acts on.
 *
 * `reconnect` is the one that matters: the grant is gone and no retry helps,
 * so the page offers to reconnect rather than a "try again" that cannot work.
 */
export type JiraFetchError =
  | { kind: "reconnect" }
  /**
   * The Atlassian app itself lacks a scope the endpoint needs. Distinct from
   * `reconnect` because no action by this user fixes it: the token is live,
   * and consenting again produces an identical one.
   */
  | { kind: "scope"; message: string }
  | { kind: "jira" }
  | { kind: "other"; message: string };

/** Turns a failed response into the error the page renders. */
function toFetchError(error: unknown): JiraFetchError {
  const body =
    error instanceof ApiError
      ? { code: error.code, error: error.message }
      : null;

  if (body?.code === "reconnect") {
    return { kind: "reconnect" };
  }
  if (body?.code === "scope") {
    // The server's wording is used as it stands: it names what is missing and
    // where, which a generic string here would lose.
    return {
      kind: "scope",
      message: body.error ?? "This Atlassian app is missing a Jira scope.",
    };
  }
  if (body?.code === "jira") {
    return { kind: "jira" };
  }
  return {
    kind: "other",
    message: body?.error ?? "Could not reach the server.",
  };
}

export interface JiraBoards {
  /** Registered boards. */
  boards: JiraBoard[];
  loading: boolean;
  error: JiraFetchError | null;
  /**
   * Re-reads a site's boards from Jira and records any that are new.
   * Resolves to the ids of boards seen for the first time — which the API
   * has started sizing — or null on failure.
   *
   * There is no "add a board": every board on a connected site is registered
   * when the site is connected, and this is how boards created since get
   * picked up — called when a site's page opens, where somebody is actually
   * looking at the list.
   */
  sync: (connectionId: string) => Promise<string[] | null>;
  /** One ticket in full. Read live, stored nowhere. */
  issue: (boardId: string, issueKey: string) => Promise<JiraIssueDetail | null>;
  /**
   * Links the repository a board's tickets are about, or unlinks it with
   * null. Resolves to null once saved, or to what to say when it was not.
   */
  linkRepository: (
    boardId: string,
    repoId: string | null,
  ) => Promise<string | null>;
  refresh: () => Promise<void>;
}

/** Registered boards, and the live read of one ticket through them. */
export function useJiraBoards(organizationId: string | undefined): JiraBoards {
  const cache = useQueryClient();
  const userId = useUserId();
  const query = useOwnerQuery<JiraBoard[]>(
    organizationId,
    "jira-boards",
    (owner, signal) => withoutJira(clients.jira.boards(owner, signal)),
  );
  const boards = query.data ?? [];
  const loading = organizationId !== undefined && query.isPending;
  const [actionError, setError] = useState<JiraFetchError | null>(null);
  const error =
    actionError ??
    (query.isError
      ? { kind: "other" as const, message: "Could not reach the server." }
      : null);
  const refresh = useCallback(async () => {
    await query.refresh();
  }, [query.refresh]);

  const sync = useCallback(
    async (connectionId: string) => {
      if (organizationId === undefined) return null;
      try {
        const added = await clients.jira.sync(organizationId, connectionId);
        setError(null);
        await refresh();
        return added;
      } catch (error) {
        setError(toFetchError(error));
        return null;
      }
    },
    [organizationId, refresh],
  );
  const issue = useCallback(
    async (boardId: string, issueKey: string) => {
      if (organizationId === undefined) return null;
      try {
        const result = await cache.fetchQuery({
          queryKey: queryKeys.resource(
            userId,
            organizationId,
            "jira-issue",
            boardId,
            issueKey,
          ),
          queryFn: ({ signal }) =>
            clients.jira.issue(organizationId, boardId, issueKey, signal),
          staleTime: 0,
        });
        setError(null);
        return result;
      } catch (error) {
        setError(toFetchError(error));
        return null;
      }
    },
    [organizationId, cache, userId],
  );
  const linkRepository = useCallback(
    async (boardId: string, repoId: string | null) => {
      if (organizationId === undefined)
        return "Could not link that repository.";
      try {
        const saved = await clients.jira.updateBoard(organizationId, boardId, {
          sourceRepoId: repoId,
        });
        query.setData((current) =>
          (current ?? []).map((board) =>
            board.id === saved.id ? saved : board,
          ),
        );
        return null;
      } catch (error) {
        return error instanceof ApiError
          ? error.status === 404
            ? "That repository is no longer registered here."
            : error.status === 403
              ? "Only an owner or admin may change the repository."
              : "Could not link that repository."
          : "Could not reach the server.";
      }
    },
    [organizationId, query.setData],
  );

  return {
    boards,
    loading,
    error,
    sync,
    issue,
    linkRepository,
    refresh,
  };
}
