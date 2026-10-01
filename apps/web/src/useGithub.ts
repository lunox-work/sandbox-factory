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
  GithubAvailableInstallationDto,
  GithubConnectionDto,
  GithubConnectOutcome,
  GithubGrantDto,
  GithubInstallationRepositoryDto,
  GithubRepoDto,
} from "@sandbox-factory/shared";
import { GITHUB_CONNECT_OUTCOMES } from "@sandbox-factory/shared";
import { useCallback, useEffect, useState } from "react";

const base = (organizationId: string) =>
  `/api/v1/orgs/${encodeURIComponent(organizationId)}/github`;

/** The API's error body, read defensively. */
async function failureOf(
  res: Response,
  fallback: string,
): Promise<{ ok: false; error: string; code?: string }> {
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  return {
    ok: false,
    // A 404's own words are "Not found", which tells a person nothing about
    // what they pressed; ours say what could not be done.
    error:
      res.status !== 404 && typeof body?.error === "string"
        ? body.error
        : fallback,
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
  };
}

/** Whether a response is the API saying GitHub is not set up on it. */
async function isUnconfigured(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === "unconfigured";
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
  const [state, setState] = useState<{
    connections: GithubConnectionDto[];
    loading: boolean;
    error: string | null;
    unconfigured: boolean;
  }>({ connections: [], loading: true, error: null, unconfigured: false });

  const refresh = useCallback(async () => {
    if (organizationId === undefined) {
      setState({
        connections: [],
        loading: false,
        error: null,
        unconfigured: false,
      });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    try {
      const res = await fetch(`${base(organizationId)}/connections`, {
        credentials: "include",
      });
      if (await isUnconfigured(res)) {
        setState({
          connections: [],
          loading: false,
          error: null,
          unconfigured: true,
        });
        return;
      }
      if (!res.ok) {
        setState({
          connections: [],
          loading: false,
          error: "Could not load your GitHub connections.",
          unconfigured: false,
        });
        return;
      }
      const body = (await res.json()) as {
        connections?: GithubConnectionDto[];
      } | null;
      // Defaulted rather than trusted, as with Jira: a response of the wrong
      // shape renders an empty list rather than throwing in a component.
      setState({
        connections: body?.connections ?? [],
        loading: false,
        error: null,
        unconfigured: false,
      });
    } catch {
      setState({
        connections: [],
        loading: false,
        error: "Could not reach the server.",
        unconfigured: false,
      });
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        const res = await fetch(
          `${base(organizationId)}/connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!res.ok) {
          return failureOf(res, "Could not disconnect that account.");
        }
        await refresh();
        return { ok: true, value: undefined };
      } catch {
        return {
          ok: false,
          error: "Could not reach the server. The account is still connected.",
        };
      }
    },
    [organizationId, refresh],
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
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
    );
  }, []);

  return {
    outcome,
    dismiss: useCallback(() => setOutcome(null), []),
  };
}

/** The installations the signed-in person can see, for the picker. */
export async function fetchAvailableInstallations(
  organizationId: string,
): Promise<
  Result<{
    grant: GithubGrantDto;
    installations: GithubAvailableInstallationDto[];
  }>
> {
  try {
    const res = await fetch(`${base(organizationId)}/connections/available`, {
      credentials: "include",
    });
    if (!res.ok) {
      return failureOf(res, "Could not list your GitHub installations.");
    }
    const body = (await res.json()) as {
      grant?: GithubGrantDto;
      installations?: GithubAvailableInstallationDto[];
    } | null;
    return {
      ok: true,
      value: {
        grant: body?.grant ?? { githubLogin: "", healthy: true },
        installations: body?.installations ?? [],
      },
    };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** Links an installation from the picker. */
export async function linkInstallation(
  organizationId: string,
  installationId: string,
): Promise<Result> {
  try {
    const res = await fetch(`${base(organizationId)}/connections`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId }),
    });
    if (!res.ok) {
      return failureOf(res, "Could not connect that installation.");
    }
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** What one installation can see, live from GitHub. */
export async function fetchInstallationRepositories(
  organizationId: string,
  connectionId: string,
): Promise<Result<GithubInstallationRepositoryDto[]>> {
  try {
    const res = await fetch(
      `${base(organizationId)}/connections/${encodeURIComponent(connectionId)}/repositories`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return failureOf(res, "Could not list that account's repositories.");
    }
    const body = (await res.json()) as {
      repositories?: GithubInstallationRepositoryDto[];
    } | null;
    return { ok: true, value: body?.repositories ?? [] };
  } catch {
    return { ok: false, error: "Could not reach the server." };
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
  const [state, setState] = useState<{
    repos: GithubRepoDto[];
    loading: boolean;
    error: string | null;
  }>({ repos: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    if (organizationId === undefined) {
      setState({ repos: [], loading: false, error: null });
      return;
    }
    try {
      const res = await fetch(`${base(organizationId)}/repositories`, {
        credentials: "include",
      });
      if (await isUnconfigured(res)) {
        // Said once, by the connections read; not a second error here.
        setState({ repos: [], loading: false, error: null });
        return;
      }
      if (!res.ok) {
        setState({
          repos: [],
          loading: false,
          error: "Could not load the registered repositories.",
        });
        return;
      }
      const body = (await res.json()) as {
        repositories?: GithubRepoDto[];
      } | null;
      setState({
        repos: body?.repositories ?? [],
        loading: false,
        error: null,
      });
    } catch {
      setState({
        repos: [],
        loading: false,
        error: "Could not reach the server.",
      });
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const register = useCallback(
    async (connectionId: string, externalId: string): Promise<Result> => {
      if (organizationId === undefined) {
        return { ok: false, error: "Could not register that repository." };
      }
      try {
        const res = await fetch(
          `${base(organizationId)}/connections/${encodeURIComponent(connectionId)}/repositories`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ externalId, role: "source" }),
          },
        );
        if (!res.ok) {
          return failureOf(res, "Could not register that repository.");
        }
        await refresh();
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: "Could not reach the server." };
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
        const res = await fetch(
          `${base(organizationId)}/repositories/${encodeURIComponent(repoId)}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!res.ok) {
          return failureOf(res, "Could not remove that repository.");
        }
        await refresh();
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: "Could not reach the server." };
      }
    },
    [organizationId, refresh],
  );

  return { ...state, refresh, register, remove };
}
