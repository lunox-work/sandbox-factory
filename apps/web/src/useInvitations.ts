/**
 * How many organizations are waiting for an answer.
 *
 * Nothing is emailed — an invitation appears on the invitee's account page and
 * nowhere else — so until this existed, the only way to discover one was to
 * open Account and scroll. Somebody invited to a client's organization could
 * sit there for a week without knowing.
 *
 * The count, not the list: the rail marks that there is something to answer,
 * and the account page is where they are answered. Fetching the same rows
 * twice would be two requests to render one badge.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useUserId, useInvitationsQuery } from "./data/query";

export interface Invitations {
  count: number;
  refresh: () => Promise<void>;
}
export function useInvitations(): Invitations {
  const userId = useUserId();
  const client = useQueryClient();
  const query = useInvitationsQuery();
  const refresh = useCallback(async () => {
    await client.invalidateQueries({
      queryKey: queryKeys.me(userId, "invitations"),
    });
  }, [client, userId]);
  return { count: query.data?.length ?? 0, refresh };
}
