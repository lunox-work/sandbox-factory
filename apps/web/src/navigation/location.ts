import { useSyncExternalStore } from "react";

export interface LocationSnapshot {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

let snapshot: LocationSnapshot | undefined;
const listeners = new Set<() => void>();

export function getLocation(): LocationSnapshot {
  const { pathname, search } = window.location;
  const hash = window.location.hash ?? "";
  if (
    snapshot?.pathname !== pathname ||
    snapshot.search !== search ||
    snapshot.hash !== hash
  )
    snapshot = { pathname, search, hash };
  return snapshot;
}

function notify() {
  getLocation();
  for (const listener of listeners) listener();
}

export function subscribeLocation(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("popstate", notify);
      window.removeEventListener("hashchange", notify);
    }
  };
}

export function useLocation(): LocationSnapshot {
  return useSyncExternalStore(subscribeLocation, getLocation);
}

export function pushLocation(url: string, state: unknown = null) {
  window.history.pushState(state, "", url);
  notify();
}

export function replaceLocation(
  url: string,
  state: unknown = window.history.state,
) {
  window.history.replaceState(state, "", url);
  notify();
}

/** Update only the selected query fields, retaining the destination and hash. */
export function updateSearch(
  change: (params: URLSearchParams) => void,
  replace = false,
) {
  const location = getLocation();
  const params = new URLSearchParams(location.search);
  change(params);
  const query = params.toString();
  const url =
    location.pathname + (query === "" ? "" : `?${query}`) + location.hash;
  if (replace) replaceLocation(url);
  else pushLocation(url);
}
