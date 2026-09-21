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

import { useCallback, useEffect, useState } from "react";

export interface Invitations {
  /** Pending invitations, or 0 while the request is in flight. */
  count: number;
  /** Re-reads, after one has been accepted or declined. */
  refresh: () => Promise<void>;
}

export function useInvitations(): Invitations {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/me/invitations", {
        credentials: "include",
      });
      if (!res.ok) {
        // Silent: this decorates the rail. A failure here should not put an
        // error on a page that is about something else, and the account page
        // reports its own.
        setCount(0);
        return;
      }
      const body = (await res.json()) as { invitations?: unknown[] } | null;
      // Defaulted, not trusted — as `useOrganizations` and `Account` both do:
      // a 200 carrying the wrong shape should show no badge rather than throw
      // through the whole app shell.
      setCount(body?.invitations?.length ?? 0);
    } catch {
      setCount(0);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { count, refresh };
}
