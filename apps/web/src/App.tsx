import { useEffect, useState } from "react";

import { LoadingLine } from "@/components/Message";

import { Account } from "./Account";
import { signOut, useSession } from "./auth";
import { Breadcrumbs } from "./Breadcrumbs";
import { Home } from "./Home";
import { CreateOrganization, Organization } from "./Organization";
import { Organizations } from "./Organizations";
import { Jira, JiraBoard, JiraSite } from "./Jira";
import { SideNav, type Screen } from "./SideNav";
import { SignIn } from "./SignIn";
import { useOrganizations } from "./useOrganizations";

export function App() {
  const { data: session, isPending } = useSession();

  // Three states, not two: rendering sign-in while the session resolves would
  // flash it at a signed-in user on every reload.
  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <LoadingLine />
      </main>
    );
  }

  if (session === null) {
    return <SignIn />;
  }

  /**
   * Keyed by user id, so switching account remounts everything below. Without
   * the key, the connection list keeps the previous user's rows on screen
   * until a refetch replaces them, which reads as one account showing
   * another's data.
   */
  return (
    <Signed
      key={session.user.id}
      userId={session.user.id}
      name={session.user.name}
      email={session.user.email}
      image={session.user.image}
    />
  );
}

function Signed({
  userId,
  name,
  email,
  image,
}: {
  /** Seeds the generated avatar wherever this person is shown. */
  userId: string;
  name: string;
  email?: string | undefined;
  image?: string | null;
}) {
  // A value rather than a router: a handful of screens, each with a path.
  // Read from the path so a reload, a bookmark, or the return from a provider
  // link all land on the screen the URL names.
  const [screen, setScreen] = useState<Screen>(() =>
    screenForPath(window.location.pathname),
  );

  /**
   * The organization the app is showing. The handle in the URL wins over the
   * remembered choice, so `/o/acme/settings` opens Acme even when another was
   * active last.
   */
  const organizations = useOrganizations(slugForPath(window.location.pathname));

  /**
   * The connected site `org-jira-site` is showing, from the URL.
   *
   * Held in state beside the screen rather than read from `window.location`
   * at render time, for the same reason the screen is: a `popstate` has to
   * change both together, and a value read during render would not re-render
   * when the URL changed under it.
   */
  const [connectionId, setConnectionId] = useState<string | undefined>(() =>
    connectionForPath(window.location.pathname),
  );

  /** The board `org-jira-board` is showing, from the URL's last segment. */
  const [boardId, setBoardId] = useState<string | undefined>(() =>
    boardForPath(window.location.pathname),
  );

  /**
   * The name of the site on screen, reported up by `JiraSite` so the trail
   * can name it. The shell renders the trail and the page owns the list the
   * name comes from, and this is the seam between the two.
   */
  const [siteName, setSiteName] = useState<string | undefined>(undefined);

  /** The same, for the board on screen. See `siteName`. */
  const [boardName, setBoardName] = useState<string | undefined>(undefined);

  /*
   * The Back button. `pushState` below adds an entry per navigation, so the
   * browser offers to go back — and this is what makes it do something:
   * without it the URL would change while the screen stayed put.
   */
  useEffect(() => {
    function onPopState() {
      setScreen(screenForPath(window.location.pathname));
      setConnectionId(connectionForPath(window.location.pathname));
      setBoardId(boardForPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * `slug` names the organization a path should carry, for the rows on the
   * organizations page: `select` has not re-rendered yet when this runs, so
   * reading the active one here would write the *previous* organization's
   * handle into the URL.
   *
   * `id` is the connected site `org-jira-site` names. It is part of what a
   * navigation is, not a detail the target screen looks up afterwards — two
   * sites are the same screen at different URLs.
   */
  function navigate(next: Screen, slug?: string, id?: string, board?: string) {
    if (
      next === screen &&
      slug === undefined &&
      id === connectionId &&
      board === boardId
    ) {
      return;
    }
    // `pushState`, so each navigation is its own history entry and Back
    // returns to the previous screen rather than leaving the app.
    window.history.pushState(
      null,
      "",
      pathForScreen(next, slug ?? organizations.active?.slug, id, board),
    );
    setScreen(next);
    setConnectionId(id);
    setBoardId(board);
  }

  return (
    /*
      A flex row, as in the reference: the rail is a static sibling of the
      content rather than laid over it, and the content scrolls in its own box
      so the rail cannot scroll away.

      On a phone the rail is a fixed bottom bar instead, so the row collapses
      and the padding keeps the last row clear of it.
    */
    <div className="flex min-h-dvh flex-col sm:h-dvh sm:flex-row sm:overflow-hidden">
      <SideNav
        screen={screen}
        userId={userId}
        name={name}
        email={email}
        image={image}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
      <div className="min-w-0 flex-1 pb-16 sm:overflow-y-auto sm:pb-0">
        {/*
          Above the page rather than inside it, so every screen gets the same
          trail in the same place. The organization is passed only once it has
          loaded — see `trailFor`, which drops the crumb rather than showing a
          placeholder that shifts the row when the name arrives.

          The pages open with their own top padding, sized for a page that
          starts at the top of the column. With a trail above them that reads
          as a gap, so the wrapper pulls the first child's padding back rather
          than editing it on all five pages — each of which would then have to
          know whether a trail is above it.
        */}
        <Breadcrumbs
          screen={screen}
          organization={
            organizations.active === null
              ? undefined
              : {
                  name: organizations.active.name,
                  slug: organizations.active.slug,
                }
          }
          siteName={
            screen === "org-jira-site" || screen === "org-jira-board"
              ? siteName
              : undefined
          }
          boardName={screen === "org-jira-board" ? boardName : undefined}
          connectionId={connectionId}
          onNavigate={navigate}
        />
        {screen === "account" ? (
          <Account
            onJoined={() => void organizations.refresh()}
            // The rename also renamed the personal organization, so the
            // switcher would otherwise keep showing the previous name.
            onRenamed={() => void organizations.refresh()}
            organizationCount={organizations.organizations.length}
            onOpenOrganizations={() => navigate("organizations")}
          />
        ) : screen === "organizations" ? (
          <Organizations
            organizations={organizations.organizations}
            viewer={{ id: userId, image }}
            loading={organizations.loading}
            error={organizations.error}
            onOpen={(organization) => {
              // Selecting here is what makes `org-settings` show this one:
              // the settings screen reads the active organization.
              organizations.select(organization.id);
              navigate("org-settings", organization.slug);
            }}
            onCreate={() => navigate("create-org")}
          />
        ) : screen === "create-org" ? (
          <CreateOrganization
            onCreated={(id, slug) => {
              void organizations.refresh();
              organizations.select(id);
              // Into the new organization, not home: creating one is the start
              // of setting it up. The slug is passed because `select` has not
              // re-rendered yet — see `navigate`.
              navigate("org-settings", slug);
            }}
            // Back to the list this form was opened from, which the trail
            // also names as its parent — not home, one level past it.
            onCancel={() => navigate("organizations")}
          />
        ) : screen === "org-jira-board" ? (
          organizations.active === null ||
          connectionId === undefined ||
          boardId === undefined ? (
            <NoOrganization loading={organizations.loading} />
          ) : (
            <JiraBoard
              // Keyed by the board, so moving between two boards remounts
              // rather than showing the previous board's tickets while the
              // new ones load.
              key={`${organizations.active.id}:${boardId}`}
              organizationId={organizations.active.id}
              connectionId={connectionId}
              boardId={boardId}
              boardName={boardName}
              onBoardName={setBoardName}
              onSiteName={setSiteName}
            />
          )
        ) : screen === "org-jira-site" ? (
          organizations.active === null || connectionId === undefined ? (
            <NoOrganization loading={organizations.loading} />
          ) : (
            <JiraSite
              // Keyed by both, so moving between two sites remounts rather
              // than leaving the previous site's boards on screen while the
              // new ones load.
              key={`${organizations.active.id}:${connectionId}`}
              organizationId={organizations.active.id}
              connectionId={connectionId}
              role={organizations.active.role}
              onDisconnected={() => {
                navigate("org-jira", organizations.active?.slug);
              }}
              onOpenBoard={(board) => {
                // The name is carried across rather than waited for: the list
                // that has it is on this page, and the board page would
                // otherwise open on a heading that says nothing.
                setBoardName(board.name);
                navigate(
                  "org-jira-board",
                  organizations.active?.slug,
                  connectionId,
                  board.id,
                );
              }}
              onSiteName={setSiteName}
            />
          )
        ) : screen === "org-jira" ? (
          organizations.active === null ? (
            <NoOrganization loading={organizations.loading} />
          ) : (
            <Jira
              // Keyed by id for the same reason as the settings page: the
              // connection list belongs to one organization.
              key={organizations.active.id}
              organizationId={organizations.active.id}
              organizationName={organizations.active.name}
              role={organizations.active.role}
              onOpenSite={(connection) => {
                navigate(
                  "org-jira-site",
                  organizations.active?.slug,
                  connection.id,
                );
              }}
            />
          )
        ) : screen === "org-settings" ? (
          organizations.active === null ? (
            <NoOrganization loading={organizations.loading} />
          ) : (
            <Organization
              // Keyed by id so switching organization remounts the forms
              // rather than leaving the previous one's handle in the field.
              key={organizations.active.id}
              organization={organizations.active}
              onChanged={() => void organizations.refresh()}
              onOpenJira={() => {
                navigate("org-jira", organizations.active?.slug);
              }}
              onLeft={() => {
                void organizations.refresh();
                navigate("home");
              }}
            />
          )
        ) : (
          <Home
            organizations={organizations.organizations}
            organizationsLoading={organizations.loading}
            onOpen={(organization) => {
              // Selecting is what makes the Jira screen show this one, as on
              // the organizations page.
              organizations.select(organization.id);
              navigate("org-jira", organization.slug);
            }}
            onOpenSite={(organization, connection) => {
              // Straight to the site, rather than to the list it is in: the
              // row named one, and stopping a level short of it would make
              // the reader find it again. The slug is passed because `select`
              // has not re-rendered yet — see `navigate`.
              organizations.select(organization.id);
              navigate("org-jira-site", organization.slug, connection.id);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What an organization-owned screen shows when there is no organization to
 * show it for.
 *
 * Either the list has not arrived or the person is in none. Both read the same
 * from here, and both are transient — which is why this is a line rather than
 * an empty state offering to create one.
 *
 * One component rather than the four copies the four screens used to carry:
 * they were the same block, and three of them had drifted to padding no page
 * uses, so the line moved when the organization arrived.
 */
function NoOrganization({ loading }: { loading: boolean }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {loading ? (
        <LoadingLine />
      ) : (
        <p className="text-muted-foreground text-sm">
          You are not in an organization yet.
        </p>
      )}
    </main>
  );
}

/**
 * The path each screen lives at, and the screen each path names.
 *
 * One pair of functions rather than a router: a handful of screens, where a
 * table would be more machinery than mapping. Anything unrecognised is the
 * home screen, so a stale bookmark or a typo lands somewhere useful instead of
 * on a blank page — which is also what nginx's `try_files` and the dev
 * server's history fallback already assume by serving `index.html` for any
 * path.
 */
const ACCOUNT_PATH = "/account";
const ORGANIZATIONS_PATH = "/organizations";
const NEW_ORG_PATH = "/organizations/new";

/**
 * The organization handle a path names, for `/o/{slug}/...`. Undefined
 * elsewhere, which leaves the remembered choice in charge.
 */
function slugForPath(pathname: string): string | undefined {
  // Not a regex: `[1]` on a split is enough, and a handle is already
  // constrained by the core rules.
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]
    : undefined;
}

/**
 * The connected site a path names, for `/o/{slug}/jira/{id}`.
 *
 * Undefined everywhere else, including on the Jira list itself — a screen
 * without a site is what that page is.
 */
function connectionForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" &&
    parts[3] === "jira" &&
    parts[4] !== undefined &&
    parts[4] !== ""
    ? parts[4]
    : undefined;
}

/**
 * The board a path names, for `/o/{slug}/jira/{id}/{board}`.
 *
 * Undefined on the site page above it, which is a screen without a board in
 * the same way the Jira list is a screen without a site.
 */
function boardForPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/+$/, "").split("/");
  return parts[1] === "o" &&
    parts[3] === "jira" &&
    parts[5] !== undefined &&
    parts[5] !== ""
    ? parts[5]
    : undefined;
}

function screenForPath(pathname: string): Screen {
  // Trailing slashes are equivalent: `/account/` is the same screen.
  const path = pathname.replace(/\/+$/, "");
  if (path === ACCOUNT_PATH) {
    return "account";
  }
  if (path === NEW_ORG_PATH) {
    return "create-org";
  }
  if (path === ORGANIZATIONS_PATH) {
    return "organizations";
  }
  if (slugForPath(pathname) !== undefined) {
    if (connectionForPath(pathname) !== undefined) {
      return boardForPath(pathname) === undefined
        ? "org-jira-site"
        : "org-jira-board";
    }
    // `/o/:slug/jira` and `/o/:slug/settings` differ only in the last segment.
    return path.endsWith("/jira") ? "org-jira" : "org-settings";
  }
  return "home";
}

function pathForScreen(
  screen: Screen,
  slug?: string | undefined,
  connectionId?: string | undefined,
  boardId?: string | undefined,
): string {
  switch (screen) {
    case "account":
      return ACCOUNT_PATH;
    case "organizations":
      return ORGANIZATIONS_PATH;
    case "create-org":
      return NEW_ORG_PATH;
    case "org-settings":
      // Without an organization there is nothing to name, so fall back to the
      // list rather than inventing a handle.
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/settings`;
    case "org-jira":
      return slug === undefined ? ORGANIZATIONS_PATH : `/o/${slug}/jira`;
    case "org-jira-site":
      // Without either half there is no site to name, so this falls back to
      // the list it came from rather than inventing a URL that resolves to a
      // different screen.
      return slug === undefined || connectionId === undefined
        ? slug === undefined
          ? ORGANIZATIONS_PATH
          : `/o/${slug}/jira`
        : `/o/${slug}/jira/${encodeURIComponent(connectionId)}`;
    case "org-jira-board":
      // Without a board this is the site it belongs to, which is the screen
      // one step up rather than an invented URL.
      return slug === undefined || connectionId === undefined
        ? pathForScreen("org-jira", slug)
        : boardId === undefined
          ? pathForScreen("org-jira-site", slug, connectionId)
          : `/o/${slug}/jira/${encodeURIComponent(connectionId)}/${encodeURIComponent(boardId)}`;
    case "home":
      return "/";
  }
}
