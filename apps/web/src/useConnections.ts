import { useQueries, useQueryClient } from "@tanstack/react-query";
import { withoutJira } from "./useJira";
import { clients, queryKeys, useUserId } from "./data/query";
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
import { useCallback } from "react";

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

export function useConnections(
  organizations: MembershipDto[],
  organizationsLoading: boolean,
): Connections {
  const userId = useUserId();
  const client = useQueryClient();
  const queries = useQueries({
    queries: organizations.map((organization) => ({
      queryKey: queryKeys.resource(userId, organization.id, "jira-connections"),
      enabled: !organizationsLoading,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        withoutJira(clients.jira.connections(organization.id, signal)),
    })),
  });
  const groups = organizations.map((organization, index) => ({
    organization,
    connections: queries[index]?.data ?? [],
    failed: queries[index]?.isError ?? false,
  }));
  const ids = organizations.map((o) => o.id).join(",");
  const refresh = useCallback(async () => {
    await Promise.all(
      ids
        .split(",")
        .filter(Boolean)
        .map((owner) =>
          client.invalidateQueries({
            queryKey: queryKeys.resource(userId, owner, "jira-connections"),
          }),
        ),
    );
  }, [client, userId, ids]);
  return {
    groups,
    loading: organizationsLoading || queries.some((query) => query.isPending),
    error:
      groups.length > 0 && groups.every((g) => g.failed)
        ? "Could not load your connections."
        : null,
    total: groups.reduce(
      (sum, g) => sum + g.connections.filter((c) => c.healthy).length,
      0,
    ),
    refresh,
  };
}
