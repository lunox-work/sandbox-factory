import type { Screen } from "./SideNav";

export const ACCOUNT_PATH = "/account";
export const ORGANIZATIONS_PATH = "/organizations";
export const NEW_ORG_PATH = "/organizations/new";

export function slugForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]
    : undefined;
}

export function connectionForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" &&
    parts[3] === "jira" &&
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
  if (path === NEW_ORG_PATH) return "create-org";
  if (path === ORGANIZATIONS_PATH) return "organizations";
  if (slugForPath(pathname) !== undefined) {
    if (connectionForPath(pathname) !== undefined) {
      return boardForPath(pathname) === undefined
        ? "org-jira-site"
        : "org-jira-board";
    }
    return path.endsWith("/jira") ? "org-jira" : "org-settings";
  }
  return "home";
}

export function pathForScreen(
  screen: Screen,
  slug?: string,
  connectionId?: string,
  boardId?: string,
): string {
  switch (screen) {
    case "account":
      return ACCOUNT_PATH;
    case "organizations":
      return ORGANIZATIONS_PATH;
    case "create-org":
      return NEW_ORG_PATH;
    case "org-settings":
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/settings`;
    case "org-jira":
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/jira`;
    case "org-jira-site":
      return slug === undefined || connectionId === undefined
        ? pathForScreen("org-jira", slug)
        : `/o/${slug}/jira/${encodeURIComponent(connectionId)}`;
    case "org-jira-board":
      return slug === undefined || connectionId === undefined
        ? pathForScreen("org-jira", slug)
        : boardId === undefined
          ? pathForScreen("org-jira-site", slug, connectionId)
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
