import type { Screen } from "./SideNav";

export const ACCOUNT_PATH = "/account";
export const ORGANIZATIONS_PATH = "/workspaces";
export const NEW_ORG_PATH = "/workspaces/new";

/**
 * The paths these pages had before organizations were called workspaces.
 * Still read, so a bookmark or a link in an old message lands on the same
 * page; never written.
 */
const LEGACY_ORGANIZATIONS_PATH = "/organizations";
const LEGACY_NEW_ORG_PATH = "/organizations/new";

/**
 * The tools an organization's settings list under Connections, and the
 * overview in front of them. `home` is the default and never written to the
 * URL, so a plain `/o/acme/settings` opens on it.
 */
export const CONNECTION_TABS = ["home", "jira", "github", "slack"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];

/**
 * Which Connections tab a query string names. A Jira outcome in the query
 * means the OAuth round trip has just come back, and the banner that explains
 * it is on the Jira tab, so that tab opens whatever else the query says.
 */
export function connectionTabForSearch(search: string): ConnectionTab {
  const params = new URLSearchParams(search);
  if (params.has("jira")) return "jira";
  const value = params.get("connection");
  return CONNECTION_TABS.some((tab) => tab === value)
    ? (value as ConnectionTab)
    : "home";
}

/**
 * The organization's Jira pages that moved into settings: the list of sites,
 * `/o/:slug/jira`, and one site, `/o/:slug/jira/:site`. Both are the Jira tab
 * now. A board, one segment deeper, is still a page of its own.
 */
function legacyJiraSlug(path: string): string | undefined {
  const parts = path.split("/");
  return (parts.length === 4 || parts.length === 5) &&
    parts[1] === "o" &&
    parts[3] === "jira" &&
    parts[2] !== undefined &&
    parts[2] !== ""
    ? parts[2]
    : undefined;
}

/**
 * The current URL for one of the legacy paths above, so the address bar stops
 * showing the old one once the page has loaded. Undefined for any other path.
 *
 * Takes and returns the query as well as the path: the old Jira page is now a
 * tab named in the query, and an OAuth outcome riding on the old path
 * (`/o/acme/jira?jira=connected`) must survive the rewrite, or the banner
 * that explains it is lost.
 */
export function canonicalUrl(
  pathname: string,
  search: string,
): string | undefined {
  const path = pathname.replace(/\/+$/, "");
  if (path === LEGACY_ORGANIZATIONS_PATH) return ORGANIZATIONS_PATH + search;
  if (path === LEGACY_NEW_ORG_PATH) return NEW_ORG_PATH + search;
  const slug = legacyJiraSlug(path);
  if (slug !== undefined) {
    const params = new URLSearchParams(search);
    params.set("connection", "jira");
    return `/o/${slug}/settings?${params.toString()}`;
  }
  return undefined;
}

export function slugForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]
    : undefined;
}

/**
 * The site a board URL names. Only a board's: `/o/:slug/jira/:site` alone is
 * no longer a page (it redirects to the Jira tab of settings), so a site id
 * with no board after it names nothing on screen.
 */
export function connectionForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return boardForPath(pathname) !== undefined &&
    parts[4] !== undefined &&
    parts[4] !== ""
    ? parts[4]
    : undefined;
}

export function boardForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" &&
    parts[3] === "jira" &&
    parts[5] !== undefined &&
    parts[5] !== ""
    ? parts[5]
    : undefined;
}

export function screenForPath(pathname: string): Screen {
  const path = pathname.replace(/\/+$/, "");
  if (path === ACCOUNT_PATH) return "account";
  if (path === NEW_ORG_PATH || path === LEGACY_NEW_ORG_PATH) {
    return "create-org";
  }
  if (path === ORGANIZATIONS_PATH || path === LEGACY_ORGANIZATIONS_PATH) {
    return "organizations";
  }
  if (slugForPath(pathname) !== undefined) {
    if (connectionForPath(pathname) !== undefined) {
      return "org-jira-board";
    }
    // `/o/:slug/jira` and `/o/:slug/jira/:site` included: both now live in
    // the Jira tab of settings, and `canonicalUrl` rewrites the address.
    return "org-settings";
  }
  return "home";
}

export function pathForScreen(
  screen: Screen,
  slug?: string,
  connectionId?: string,
  boardId?: string,
  /** The Connections tab `org-settings` opens on; see `CONNECTION_TABS`. */
  connectionTab?: ConnectionTab,
): string {
  switch (screen) {
    case "account":
      return ACCOUNT_PATH;
    case "organizations":
      return ORGANIZATIONS_PATH;
    case "create-org":
      return NEW_ORG_PATH;
    case "org-settings":
      return slug === undefined
        ? ORGANIZATIONS_PATH
        : connectionTab === undefined || connectionTab === "home"
          ? `/o/${slug}/settings`
          : `/o/${slug}/settings?connection=${connectionTab}`;
    case "org-jira-board":
      return slug === undefined ||
        connectionId === undefined ||
        boardId === undefined
        ? pathForScreen("org-settings", slug, undefined, undefined, "jira")
        : `/o/${slug}/jira/${encodeURIComponent(connectionId)}/${encodeURIComponent(boardId)}`;
    case "home":
      return "/";
  }
}

export function isPlainLeftClick(event: {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
