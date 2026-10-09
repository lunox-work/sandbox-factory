import type { Screen } from "./SideNav";

export const ACCOUNT_PATH = "/account";
export const ORGANIZATIONS_PATH = "/workspaces";
export const NEW_ORG_PATH = "/workspaces/new";
/** Every workspace's bounties at once, so not under any one's path. */
export const BOUNTIES_PATH = "/bounties";
export const NEW_BOUNTY_PATH = "/bounties/new";

/**
 * An open bounty as an address names it: the workspace it is read and changed
 * through, and its id.
 *
 * Written the same wherever a bounty opens, `acme/bty_1`: after `/bounties/`
 * for its own page, and as `?peek=` for the panel over the list. Opening the
 * panel as a page moves the same words from the query into the path.
 */
export interface BountyAddress {
  workspace: string;
  id: string;
}

/**
 * What followed a bounty's address while its proposal was a tab of its own,
 * `acme/bty_1/proposal`. Still read, landing on the bounty, whose proposal is
 * part of it now; never written.
 */
const LEGACY_PROPOSAL_VIEW = "proposal";

function bountyAddressText({ workspace, id }: BountyAddress): string {
  return `${encodeURIComponent(workspace)}/${encodeURIComponent(id)}`;
}

function bountyAddressFrom(parts: string[]): BountyAddress | undefined {
  const [workspace, id, view, ...rest] = parts;
  if (
    workspace === undefined ||
    workspace === "" ||
    id === undefined ||
    id === "" ||
    rest.length > 0 ||
    (view !== undefined && view !== LEGACY_PROPOSAL_VIEW)
  ) {
    return undefined;
  }
  return { workspace, id };
}

/**
 * The bounty's own address for one written with `/proposal` after it, in the
 * path or in `?peek=`. Undefined for any other. Either opens its page on the
 * Bounty tab, where the proposal now is: a panel does not show it.
 */
function legacyProposalViewUrl(
  path: string,
  search: string,
): string | undefined {
  const parts = path.split("/");
  if (parts.length === 5 && parts[4] === LEGACY_PROPOSAL_VIEW) {
    const bounty = bountyForPath(path);
    if (bounty === undefined) return undefined;
    const params = new URLSearchParams(search);
    params.set("tab", "bounty");
    return `${bountyPagePath(bounty)}?${params.toString()}`;
  }
  const peek = new URLSearchParams(search).get("peek");
  if (path !== BOUNTIES_PATH || peek === null) return undefined;
  const peekParts = peek.replace(/\/+$/, "").split("/");
  if (peekParts.length !== 3 || peekParts[2] !== LEGACY_PROPOSAL_VIEW) {
    return undefined;
  }
  const bounty = bountyForSearch(search);
  return bounty === undefined ? undefined : bountyProposalPath(bounty);
}

/** A bounty's own page, open on the tab its proposal is in. */
export function bountyProposalPath(address: BountyAddress): string {
  return `${bountyPagePath(address)}?tab=bounty`;
}

/** A bounty's own page. */
export function bountyPagePath(address: BountyAddress): string {
  return `${BOUNTIES_PATH}/${bountyAddressText(address)}`;
}

/**
 * A board whose bounties the list is narrowed to, as an address names it:
 * the workspace it is read through, and its id. Written `acme/jrb_1` in
 * `?board=`, as a bounty is in `?peek=`.
 */
export interface BoardScope {
  workspace: string;
  boardId: string;
}

/** What narrows the list: a category (or `uncategorized`), and a board. */
export interface BountyListScope {
  category?: string | undefined;
  board?: BoardScope | undefined;
}

const CATEGORY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The list's narrowing as a query names it; anything malformed is none. */
export function listScopeForSearch(search: string): BountyListScope {
  const params = new URLSearchParams(search);
  const category = params.get("category");
  const board = params.get("board");
  const [workspace, boardId, ...rest] = (board ?? "")
    .replace(/\/+$/, "")
    .split("/");
  return {
    ...(category !== null && CATEGORY_PATTERN.test(category)
      ? { category }
      : {}),
    ...(workspace !== undefined &&
    workspace !== "" &&
    boardId !== undefined &&
    boardId !== "" &&
    rest.length === 0
      ? { board: { workspace, boardId } }
      : {}),
  };
}

/**
 * The bounties, with `address` open over them, or none when null, narrowed
 * as `scope` says.
 */
export function bountiesUrl(
  address: BountyAddress | null,
  scope: BountyListScope = {},
): string {
  // Built by hand: `URLSearchParams` would write the slashes as `%2F`.
  const parts = [
    ...(scope.board === undefined
      ? []
      : [
          `board=${encodeURIComponent(scope.board.workspace)}/${encodeURIComponent(scope.board.boardId)}`,
        ]),
    ...(scope.category === undefined
      ? []
      : [`category=${encodeURIComponent(scope.category)}`]),
    ...(address === null ? [] : [`peek=${bountyAddressText(address)}`]),
  ];
  return parts.length === 0
    ? BOUNTIES_PATH
    : `${BOUNTIES_PATH}?${parts.join("&")}`;
}

/** The bounty whose page a path is: `/bounties/:workspace/:id`. */
export function bountyForPath(pathname: string): BountyAddress | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  if (parts[0] !== "" || parts[1] !== "bounties") return undefined;
  try {
    return bountyAddressFrom(parts.slice(2).map(decodeURIComponent));
  } catch {
    // A malformed escape names nothing.
    return undefined;
  }
}

/** The bounty open over the list, which `?peek=` names. */
export function bountyForSearch(search: string): BountyAddress | undefined {
  const peek = new URLSearchParams(search).get("peek");
  return peek === null
    ? undefined
    : bountyAddressFrom(peek.replace(/\/+$/, "").split("/"));
}

/**
 * A sandbox version's files, as their own page: `/sandboxes/acme/sbv_1`.
 * Opened in a tab of its own, beside the bounty, so it stands outside the
 * app's shell. `?path=` names the file open in it.
 */
export const SANDBOX_FILES_PATH = "/sandboxes";

export interface SandboxFilesAddress {
  workspace: string;
  versionId: string;
}

/** The page for a version's files, open on `path` when one is named. */
export function sandboxFilesPath(
  { workspace, versionId }: SandboxFilesAddress,
  path?: string,
): string {
  const page = `${SANDBOX_FILES_PATH}/${encodeURIComponent(workspace)}/${encodeURIComponent(versionId)}`;
  return path === undefined
    ? page
    : `${page}?${new URLSearchParams({ path }).toString()}`;
}

/** The version whose files a path is: `/sandboxes/:workspace/:versionId`. */
export function sandboxFilesForPath(
  pathname: string,
): SandboxFilesAddress | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  const [root, section, workspace, versionId, ...rest] = parts;
  if (
    root !== "" ||
    section !== "sandboxes" ||
    workspace === undefined ||
    workspace === "" ||
    versionId === undefined ||
    versionId === "" ||
    rest.length > 0
  ) {
    return undefined;
  }
  try {
    return {
      workspace: decodeURIComponent(workspace),
      versionId: decodeURIComponent(versionId),
    };
  } catch {
    return undefined;
  }
}

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
 * Which Connections tab a query string names. A Jira or GitHub outcome in the
 * query means that flow's round trip has just come back, and the banner that
 * explains it is on that tool's tab, so the tab opens whatever else the query
 * says.
 */
export function connectionTabForSearch(search: string): ConnectionTab {
  const params = new URLSearchParams(search);
  if (params.has("jira")) return "jira";
  if (params.has("github")) return "github";
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
  const board = legacyBoard(path);
  if (board !== undefined) return bountiesUrl(null, { board });
  if (path === LEGACY_ORGANIZATIONS_PATH) return ORGANIZATIONS_PATH + search;
  if (path === LEGACY_NEW_ORG_PATH) return NEW_ORG_PATH + search;
  const slug = legacyJiraSlug(path);
  if (slug !== undefined) {
    const params = new URLSearchParams(search);
    params.set("connection", "jira");
    return `/o/${slug}/settings?${params.toString()}`;
  }
  const bountiesSlug = legacyBountiesSlug(path);
  if (bountiesSlug !== undefined) {
    return legacyBountiesUrl(search, bountiesSlug) ?? BOUNTIES_PATH;
  }
  const proposalView = legacyProposalViewUrl(path, search);
  if (proposalView !== undefined) return proposalView;
  if (path === BOUNTIES_PATH) return legacyBountiesUrl(search, undefined);
  return undefined;
}

/** The query the bounties page read before `?peek=`; see `legacyBountiesUrl`. */
const LEGACY_BOUNTY_PARAMS = [
  "bounty",
  "ticket",
  "workspace",
  "proposal",
  "tab",
];

/**
 * The bounties page for a query from before `?peek=`: the open bounty as
 * `?bounty=` (`?ticket=` while bounties were called tickets), the workspace it
 * is read through as `?workspace=` or the old path's, and its proposal as
 * `?proposal=`, which opens the bounty's page on it now. `?tab=` chose
 * between lists the page no longer has.
 *
 * A proposal named with no bounty, from when proposals had a list of their
 * own, keeps its workspace and stays in the query: the page reads it for the
 * bounty it belongs to. Anything naming no workspace names nothing that can
 * be opened, and is dropped. Undefined when there is nothing to rewrite.
 */
function legacyBountiesUrl(
  search: string,
  slug: string | undefined,
): string | undefined {
  const params = new URLSearchParams(search);
  if (!LEGACY_BOUNTY_PARAMS.some((name) => params.has(name))) return undefined;
  const id = params.get("bounty") ?? params.get("ticket");
  const workspace = params.get("workspace") ?? slug ?? null;
  const proposal = params.get("proposal");
  const url =
    workspace !== null && id !== null
      ? proposal !== null
        ? bountyProposalPath({ workspace, id })
        : bountiesUrl({ workspace, id })
      : workspace !== null && proposal !== null
        ? `${BOUNTIES_PATH}?${new URLSearchParams({ workspace, proposal }).toString()}`
        : BOUNTIES_PATH;
  // Already as it should be: rewriting it would be a no-op on every load.
  return url === BOUNTIES_PATH + search ? undefined : url;
}

/**
 * `/o/:slug/bounties`, where one workspace's bounties lived before the page
 * showed every workspace's, and `/o/:slug/tickets` before that, while they
 * were called tickets. Still read, so an old link lands on the same bounty;
 * never written.
 */
function legacyBountiesSlug(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length === 4 &&
    parts[1] === "o" &&
    parts[2] !== undefined &&
    parts[2] !== "" &&
    (parts[3] === "bounties" || parts[3] === "tickets")
    ? parts[2]
    : undefined;
}

export function slugForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]
    : undefined;
}

/**
 * The repository whose page a path is: `/o/:slug/repositories/:repoId`.
 * Undefined for any other path, a malformed escape included.
 */
export function repositoryForPath(pathname: string): string | undefined {
  const [root, section, slug, kind, repoId, ...rest] = pathname
    .replace(/\/+$/, "")
    .split("/");
  if (
    root !== "" ||
    section !== "o" ||
    slug === undefined ||
    slug === "" ||
    kind !== "repositories" ||
    repoId === undefined ||
    repoId === "" ||
    rest.length > 0
  ) {
    return undefined;
  }
  try {
    return decodeURIComponent(repoId);
  } catch {
    return undefined;
  }
}

/**
 * A board's own page, `/o/:slug/jira/:site/:board`, from when a board had
 * one: its proposals, listed. A board's tickets are bounties now, so the
 * address opens the bounties narrowed to that board; never written.
 */
function legacyBoard(path: string): BoardScope | undefined {
  const [root, section, slug, kind, site, boardId, ...rest] = path.split("/");
  if (
    root !== "" ||
    section !== "o" ||
    slug === undefined ||
    slug === "" ||
    kind !== "jira" ||
    site === undefined ||
    site === "" ||
    boardId === undefined ||
    boardId === "" ||
    rest.length > 0
  ) {
    return undefined;
  }
  try {
    return {
      workspace: decodeURIComponent(slug),
      boardId: decodeURIComponent(boardId),
    };
  } catch {
    return undefined;
  }
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
  if (path === NEW_BOUNTY_PATH) return "new-bounty";
  if (bountyForPath(path) !== undefined) return "bounty";
  // The old per-workspace addresses show the page while `canonicalUrl`
  // rewrites them.
  if (path === BOUNTIES_PATH || legacyBountiesSlug(path) !== undefined) {
    return "bounties";
  }
  if (slugForPath(pathname) !== undefined) {
    // An old board address shows the list while `canonicalUrl` rewrites it.
    if (legacyBoard(path) !== undefined) return "bounties";
    if (repositoryForPath(pathname) !== undefined) {
      return "org-repository";
    }
    // `/o/:slug/jira` and `/o/:slug/jira/:site` included: both now live in
    // the Jira tab of settings, and `canonicalUrl` rewrites the address.
    return isWorkspaceSettingsPath(path) ? "org-settings" : "not-found";
  }
  return path === "" ? "home" : "not-found";
}

/**
 * The paths under `/o/:slug` that open its settings: the workspace itself,
 * `/settings`, and the Jira site pages that moved into settings. Anything
 * else under it names no page.
 */
function isWorkspaceSettingsPath(path: string): boolean {
  const rest = path.split("/").slice(3);
  return (
    rest.length === 0 ||
    (rest.length === 1 && rest[0] === "settings") ||
    legacyJiraSlug(path) !== undefined
  );
}

export function pathForScreen(
  screen: Screen,
  slug?: string,
  /** The id the screen names: a repository id for `org-repository`. */
  id?: string,
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
    case "bounties":
      return BOUNTIES_PATH;
    // A bounty's page is addressed by `bountyPagePath`; with none named here,
    // the list it is one of.
    case "bounty":
      return BOUNTIES_PATH;
    case "new-bounty":
      return NEW_BOUNTY_PATH;
    // A repository's own page. With no repository named, the GitHub tab of
    // settings, where the registered ones are listed.
    case "org-repository":
      return slug === undefined || id === undefined
        ? pathForScreen("org-settings", slug, undefined, "github")
        : `/o/${slug}/repositories/${encodeURIComponent(id)}`;
    // Nothing links to a page that is not there; home is where it leads.
    case "home":
    case "not-found":
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
