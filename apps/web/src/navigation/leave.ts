import { useSyncExternalStore } from "react";

/*
  A full-page navigation away from the app, to a provider's consent screen
  through the API. The browser can take seconds to leave — the API, then
  GitHub or Atlassian, which may only bounce straight back — and until it
  does the page it is leaving looks as though the click did nothing. Where
  it is leaving for is held here, and the app draws a full-page loading
  state over itself while it is set.

  The navigation can also never happen: Esc or the browser's Stop cancels
  it, and the page stays. Nothing tells the page so, which is why the cover
  offers its own way out (`stopLeaving`).
*/

let leaving: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null) {
  leaving = next;
  for (const listener of listeners) listener();
}

// Back from the provider can restore the page from the browser's cache
// exactly as it was left: still saying it is leaving.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) set(null);
});

/**
 * Sends the browser to `url`, saying it is opening `destination` (a
 * provider's name: "GitHub") over the page until it goes.
 */
export function leaveFor(url: string, destination: string): void {
  set(destination);
  window.location.href = url;
}

/** Gives the page back: the navigation was cancelled, or is being. */
export function stopLeaving(): void {
  set(null);
}

/** Where the page is leaving for, or null while it is not leaving. */
export function useLeaving(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => leaving,
  );
}
