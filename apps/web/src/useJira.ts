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
  connect: () => void;
  disconnect: (connectionId: string) => Promise<void>;
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

  const connect = useCallback(() => {
    if (organizationId === undefined) {
      return;
    }
    // A full-page navigation, not a fetch: the browser has to reach
    // Atlassian's consent screen, and an XHR would fail CORS trying.
    const returnTo = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/api/v1/orgs/${encodeURIComponent(
      organizationId,
    )}/jira/connect?returnTo=${returnTo}`;
  }, [organizationId]);

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (organizationId === undefined) {
        return;
      }
      const res = await fetch(
        `/api/v1/orgs/${encodeURIComponent(
          organizationId,
        )}/jira/connections/${encodeURIComponent(connectionId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        setState((current) => ({
          ...current,
          error: "Could not disconnect that site.",
        }));
        return;
      }
      await refresh();
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
