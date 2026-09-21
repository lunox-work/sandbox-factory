/**
 * Every Jira connection the signed-in person can see, grouped by who owns it.
 *
 * The home screen's read. A connection belongs to an organization — personal
 * or team, the API does not distinguish — so this fans out over the
 * memberships rather than calling one endpoint: there is no "all my
 * connections" route, and adding one would have to re-derive the membership
 * check that `/api/v1/orgs/:orgId/*` already makes.
 *
 * One request per organization is acceptable because the list is small (the
 * plugin caps membership at 20) and they run concurrently. If that stops being
 * true, the fix is an aggregate endpoint, not a cache here.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { useCallback, useEffect, useState } from "react";

import type { JiraConnection } from "./useJira";

/** One organization's connections, as the home screen renders them. */
export interface ConnectionGroup {
  organization: MembershipDto;
  connections: JiraConnection[];
  /** True when that organization's own request failed. */
  failed: boolean;
}

export interface Connections {
  groups: ConnectionGroup[];
  loading: boolean;
  /** Set only when nothing could be loaded at all. */
  error: string | null;
  /**
   * Working connections across every group, so the empty state can be decided
   * once. Unhealthy ones are excluded: the page does not list them, so
   * counting them would suppress the "connect your first" line while showing
   * nothing to connect to.
   */
  total: number;
  refresh: () => Promise<void>;
}

async function loadOne(organization: MembershipDto): Promise<ConnectionGroup> {
  try {
    const res = await fetch(
      `/api/v1/orgs/${encodeURIComponent(organization.id)}/jira/connections`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return { organization, connections: [], failed: true };
    }
    const body = (await res.json()) as {
      connections?: JiraConnection[];
    } | null;
    // Defaulted rather than trusted, as elsewhere: a 200 of the wrong shape
    // renders an empty group instead of throwing through the page.
    return {
      organization,
      connections: body?.connections ?? [],
      failed: false,
    };
  } catch {
    return { organization, connections: [], failed: true };
  }
}

export function useConnections(
  organizations: MembershipDto[],
  /** True while the memberships themselves are still loading. */
  organizationsLoading: boolean,
): Connections {
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Depends on the ids, not the array: `useOrganizations` builds a new array
   * on every refresh, so depending on the array itself would refetch forever.
   */
  const key = organizations.map((entry) => entry.id).join(",");

  const refresh = useCallback(async () => {
    if (organizationsLoading) {
      return;
    }
    if (organizations.length === 0) {
      setGroups([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    // Concurrent, not sequential: these are independent reads and the slowest
    // one should set the pace, not the sum.
    const loaded = await Promise.all(organizations.map(loadOne));
    setGroups(loaded);
    setLoading(false);
    // Only a total failure is an error. One organization failing shows as a
    // message on its own group, so the rest stay usable.
    setError(
      loaded.every((group) => group.failed)
        ? "Could not load your connections."
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by ids; see above.
  }, [key, organizationsLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    groups,
    loading: loading || organizationsLoading,
    error,
    total: groups.reduce(
      (sum, group) =>
        sum + group.connections.filter((entry) => entry.healthy).length,
      0,
    ),
    refresh,
  };
}
