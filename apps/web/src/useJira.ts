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
  createdAt: string;
}

/**
 * What the callback reports back through the query string.
 *
 * Every value is a state the user can act on, which is why a failed connection
 * ends here rather than as an error page: `cancelled` and `no-sites` are not
 * faults at all, and the other two have different remedies.
 */
export type JiraOutcome =
  | "connected"
  | "write-consented"
  | "write-scope-missing"
  | "cancelled"
  | "denied"
  | "no-sites"
  | "partial-scopes"
  | "state"
  | "forbidden"
  | "error";

export interface JiraState {
  connections: JiraConnection[];
  loading: boolean;
  error: string | null;
}

export interface Jira extends JiraState {
  /** Sends the browser to Atlassian. Does not return. */
  connect: (connectionId?: string) => void;
  disconnect: (
    connectionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  refresh: () => Promise<void>;
}

export function useJira(organizationId: string | undefined): Jira {
  const [state, setState] = useState<JiraState>({
    connections: [],
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (organizationId === undefined) {
      setState({ connections: [], loading: false, error: null });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    try {
      const res = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/jira/connections`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setState({
          connections: [],
          loading: false,
          error: "Could not load your Jira connections.",
        });
        return;
      }
      const body = (await res.json()) as {
        connections?: JiraConnection[];
      } | null;
      // Defaulted rather than trusted: a response of the wrong shape should
      // render an empty list, not throw inside a component.
      setState({
        connections: body?.connections ?? [],
        loading: false,
        error: null,
      });
    } catch {
      setState({
        connections: [],
        loading: false,
        error: "Could not reach the server.",
      });
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    (connectionId?: string) => {
      if (organizationId === undefined) {
        return;
      }
      // A full-page navigation, not a fetch: the browser has to reach
      // Atlassian's consent screen, and an XHR would fail CORS trying.
      const returnTo = window.location.pathname + window.location.search;
      const query = new URLSearchParams({ returnTo });
      if (connectionId !== undefined) query.set("connectionId", connectionId);
      window.location.href = `/api/v1/orgs/${encodeURIComponent(
        organizationId,
      )}/jira/connect?${query.toString()}`;
    },
    [organizationId],
  );

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (organizationId === undefined) {
        return { ok: false as const, error: "Could not disconnect that site." };
      }
      try {
        const res = await fetch(
          `/api/v1/orgs/${encodeURIComponent(
            organizationId,
          )}/jira/connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!res.ok) {
          const error = "Could not disconnect that site.";
          setState((current) => ({ ...current, error }));
          return { ok: false as const, error };
        }
        await refresh();
        return { ok: true as const };
      } catch {
        const error =
          "Could not reach the server. The site is still connected.";
        setState((current) => ({
          ...current,
          error,
        }));
        return { ok: false as const, error };
      }
    },
    [organizationId, refresh],
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
    setOutcome(value as JiraOutcome);
    const missing = params.get("missing");
    setMissingScopes(
      missing === null || missing === "" ? [] : missing.split(","),
    );

    // Strip both, so a reload does not repeat the message.
    params.delete("jira");
    params.delete("missing");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
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
/* Boards and the backlog preview                                             */
/* -------------------------------------------------------------------------- */

/** A board this organization has registered, with its settings. */
export interface JiraBoard {
  id: string;
  connectionId: string;
  externalId: string;
  name: string;
  boardType: string;
  projectKey: string | null;
  selection: {
    maxTickets?: number;
    excludeAssigned?: boolean;
    minAgeDays?: number;
    maxAgeDays?: number | null;
    minSpecChars?: number;
  };
  writebackEnabled: boolean;
  createdAt: string;
}

/** A ticket in the preview. The same DTO a run will price. */
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

export interface BacklogPreview {
  boardId: string;
  /** Which endpoint answered: a Kanban board has no backlog of its own. */
  source: "backlog" | "board-issues";
  jql: string;
  /** The resolved rules used for this read, including server defaults. */
  selection?: {
    maxTickets: number;
    excludeAssigned: boolean;
    issueTypes: string[];
    minAgeDays: number;
    maxAgeDays?: number;
    minSpecChars: number;
  };
  issues: JiraPreviewIssue[];
  total?: number;
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
async function toFetchError(res: Response): Promise<JiraFetchError> {
  const body = (await res.json().catch(() => null)) as {
    code?: string;
    error?: string;
  } | null;
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
  return { kind: "other", message: body?.error ?? "Something went wrong." };
}

export interface JiraBoards {
  /** Registered boards. */
  boards: JiraBoard[];
  loading: boolean;
  error: JiraFetchError | null;
  /**
   * Re-reads a site's boards from Jira and records any that are new.
   *
   * There is no "add a board": every board on a connected site is registered
   * when the site is connected, and this is how boards created since get
   * picked up — called when a site's page opens, where somebody is actually
   * looking at the list.
   */
  sync: (connectionId: string) => Promise<void>;
  preview: (boardId: string) => Promise<BacklogPreview | null>;
  /** One ticket in full. Read live, stored nowhere. */
  issue: (boardId: string, issueKey: string) => Promise<JiraIssueDetail | null>;
  refresh: () => Promise<void>;
}

/**
 * Registered boards, and the two live reads that go through them.
 *
 * `preview` returns rather than storing into state: it reaches Jira, it is
 * slow enough to need its own spinner, and only one board is ever being
 * looked at. Holding every board's preview in one hook would make the page
 * re-render on a read the user is no longer waiting for.
 */
export function useJiraBoards(organizationId: string | undefined): JiraBoards {
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<JiraFetchError | null>(null);

  const base =
    organizationId === undefined
      ? undefined
      : `/api/v1/orgs/${encodeURIComponent(organizationId)}/jira`;

  const refresh = useCallback(async () => {
    if (base === undefined) {
      setBoards([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${base}/boards`, { credentials: "include" });
      if (!res.ok) {
        setError(await toFetchError(res));
        setBoards([]);
        setLoading(false);
        return;
      }
      const body = (await res.json()) as { boards?: JiraBoard[] } | null;
      setBoards(body?.boards ?? []);
      setError(null);
    } catch {
      setError({ kind: "other", message: "Could not reach the server." });
      setBoards([]);
    }
    setLoading(false);
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = useCallback(
    async (connectionId: string) => {
      if (base === undefined) {
        return;
      }
      // A POST because it writes rows, though the page means it as a read.
      try {
        const res = await fetch(
          `${base}/connections/${encodeURIComponent(connectionId)}/sync`,
          { method: "POST", credentials: "include" },
        );
        if (!res.ok) {
          setError(await toFetchError(res));
          return;
        }
        setError(null);
        await refresh();
      } catch {
        setError({ kind: "other", message: "Could not reach the server." });
      }
    },
    [base, refresh],
  );

  const preview = useCallback(
    async (boardId: string) => {
      if (base === undefined) {
        return null;
      }
      try {
        const res = await fetch(
          `${base}/boards/${encodeURIComponent(boardId)}/backlog-preview`,
          { credentials: "include" },
        );
        if (!res.ok) {
          setError(await toFetchError(res));
          return null;
        }
        setError(null);
        return (await res.json()) as BacklogPreview;
      } catch {
        setError({ kind: "other", message: "Could not reach the server." });
        return null;
      }
    },
    [base],
  );

  const issue = useCallback(
    async (boardId: string, issueKey: string) => {
      if (base === undefined) {
        return null;
      }
      try {
        const res = await fetch(
          `${base}/boards/${encodeURIComponent(boardId)}/issues/${encodeURIComponent(issueKey)}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          setError(await toFetchError(res));
          return null;
        }
        setError(null);
        const body = (await res.json()) as { issue?: JiraIssueDetail } | null;
        return body?.issue ?? null;
      } catch {
        setError({ kind: "other", message: "Could not reach the server." });
        return null;
      }
    },
    [base],
  );

  return {
    boards,
    loading,
    error,
    sync,
    preview,
    issue,
    refresh,
  };
}
