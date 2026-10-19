import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";

import { reopenRunStreams } from "./data/events";
import { stopLeaving, useLeaving } from "./navigation/leave";

/** How long a navigation may take before the cover offers a way back. */
export const SLOW_LEAVE_MS = 10_000;

/**
 * The page while the browser leaves for a provider's consent screen: drawn
 * over everything, so nothing reads as a click that did nothing, and
 * nothing is pressed twice.
 */
export function Leaving() {
  const destination = useLeaving();
  if (destination === null) return null;
  // On `body`, beside the app and any open dialog's portal rather than
  // inside them, so everything else can be made inert without the cover.
  return createPortal(
    <Cover key={destination} destination={destination} />,
    document.body,
  );
}

function Cover({ destination }: { destination: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [slow, setSlow] = useState(false);
  const client = useQueryClient();

  // Nothing behind the cover can be reached while it is up: everything
  // else on the page goes inert and focus moves here. On the way out, the
  // page is given back as it was, focus on the control that left.
  useLayoutEffect(() => {
    const cover = ref.current;
    if (cover === null) return;
    const before = document.activeElement;
    const made: Element[] = [];
    for (const element of document.body.children) {
      if (element === cover || element.hasAttribute("inert")) continue;
      element.setAttribute("inert", "");
      made.push(element);
    }
    cover.focus();
    return () => {
      for (const element of made) element.removeAttribute("inert");
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // A navigation Esc or Stop cancelled says nothing to the page, so the
  // cover would stay up for good. After a while it says it is still going
  // and offers the way back.
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Esc gives the page back at any point. On the window, capturing, so it
  // is heard before a dialog behind the cover takes it as its own close.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel(client);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [client]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Opening ${destination}`}
      tabIndex={-1}
      className="bg-background fixed inset-0 z-[100] grid place-items-center outline-none"
      data-testid="leaving"
    >
      <div className="flex flex-col items-center gap-4">
        <LoadingLine>
          {slow ? `Still opening ${destination}…` : `Opening ${destination}…`}
        </LoadingLine>
        {slow && (
          <Button variant="outline" size="sm" onClick={() => cancel(client)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Stops a navigation still under way, and takes the cover down. Stopping
 * it also aborts the page's own requests and closes its push streams, and
 * a read that failed is not tried again on its own, so the streams are
 * opened anew and every query on screen is read again.
 */
function cancel(client: QueryClient) {
  window.stop();
  stopLeaving();
  reopenRunStreams();
  void client.invalidateQueries();
}
