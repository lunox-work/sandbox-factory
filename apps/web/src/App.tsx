import { useEffect, useRef, useState } from "react";

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
import {
  boardForPath,
  connectionForPath,
  isPlainLeftClick,
  ORGANIZATIONS_PATH,
  pathForScreen,
  screenForPath,
  slugForPath,
} from "./routes";
import { useInvitations } from "./useInvitations";
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
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shouldFocusPage = useRef(false);
  const restorePageScroll = useRef(false);
  const scrollPositions = useRef(new Map<string, number>());
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

  /**
   * Organizations waiting for an answer, for the mark on the avatar. Read in
   * the shell rather than on the account page, because the rail is on every
   * screen and the account page is the one place the badge is not needed.
   */
  const invitations = useInvitations();

  /*
   * The Back button. `pushState` below adds an entry per navigation, so the
   * browser offers to go back — and this is what makes it do something:
   * without it the URL would change while the screen stayed put.
   */
  useEffect(() => {
    function onPopState() {
      shouldFocusPage.current = true;
      restorePageScroll.current = true;
      setScreen(screenForPath(window.location.pathname));
      setConnectionId(connectionForPath(window.location.pathname));
      setBoardId(boardForPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const page =
      screen === "home"
        ? "Home"
        : screen === "account"
          ? "Account"
          : screen === "organizations"
            ? "Organizations"
            : screen === "create-org"
              ? "New organization"
              : screen === "org-jira-board"
                ? (boardName ?? "Board")
                : screen === "org-jira-site"
                  ? (siteName ?? "Jira site")
                  : screen === "org-jira"
                    ? "Jira"
                    : (organizations.active?.name ?? "Organization");
    document.title = `${page} · Lunox`;
  }, [boardName, organizations.active?.name, screen, siteName]);

  useEffect(() => {
    if (!shouldFocusPage.current) {
      return;
    }
    shouldFocusPage.current = false;
    const content = contentRef.current;
    const key = window.location.pathname + window.location.search;
    const top = restorePageScroll.current
      ? (scrollPositions.current.get(key) ?? 0)
      : 0;
    restorePageScroll.current = false;
    const heading = content?.querySelector<HTMLElement>("main h1");
    if (heading !== null && heading !== undefined) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    // The content column is the scroller from `sm` up; on a phone the page
    // uses the window so the fixed bottom navigation can sit over normal
    // document flow. jsdom has no media-query layout, so it follows the
    // desktop branch and keeps navigation tests deterministic.
    const contentScrolls =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(min-width: 640px)").matches;
    if (contentScrolls) {
      content?.scrollTo?.({ top });
    } else {
      window.scrollTo({ top });
    }
  }, [boardId, connectionId, screen]);

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
    if (contentRef.current !== null) {
      const contentScrolls =
        typeof window.matchMedia !== "function" ||
        window.matchMedia("(min-width: 640px)").matches;
      scrollPositions.current.set(
        window.location.pathname + window.location.search,
        contentScrolls ? contentRef.current.scrollTop : window.scrollY,
      );
    }
    window.history.pushState(
      null,
      "",
      pathForScreen(next, slug ?? organizations.active?.slug, id, board),
    );
    shouldFocusPage.current = true;
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
        invitationCount={invitations.count}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
      <div
        ref={contentRef}
        className={`min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] sm:overflow-y-auto sm:pb-0 ${
          screen === "home" ? "" : "[&>main]:!pt-4 sm:[&>main]:!pt-6"
        }`}
      >
        {/*
          Above the page rather than inside it, so every screen gets the same
          trail in the same place. The organization is passed only once it has
          loaded — see `trailFor`, which drops the crumb rather than showing a
          placeholder that shifts the row when the name arrives.

          The pages open with their own top padding, sized for a page that
          starts at the top of the column. The shell gives routed pages one
          smaller first-block offset when a trail is present, keeping the
          spacing contract in one place.
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
            onJoined={() => {
              void organizations.refresh();
              // The one that was just accepted is no longer pending, so the
              // mark on the avatar has to go without a reload.
              void invitations.refresh();
            }}
            onDeclined={() => void invitations.refresh()}
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
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              onOpenOrganizations={() => navigate("organizations")}
            />
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
              role={organizations.active.role}
            />
          )
        ) : screen === "org-jira-site" ? (
          organizations.active === null || connectionId === undefined ? (
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              onOpenOrganizations={() => navigate("organizations")}
            />
          ) : (
            <JiraSite
              // Keyed by both, so moving between two sites remounts rather
              // than leaving the previous site's boards on screen while the
              // new ones load.
              key={`${organizations.active.id}:${connectionId}`}
              organizationId={organizations.active.id}
              organizationSlug={organizations.active.slug}
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
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              onOpenOrganizations={() => navigate("organizations")}
            />
          ) : (
            <Jira
              // Keyed by id for the same reason as the settings page: the
              // connection list belongs to one organization.
              key={organizations.active.id}
              organizationId={organizations.active.id}
              organizationSlug={organizations.active.slug}
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
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              onOpenOrganizations={() => navigate("organizations")}
            />
          ) : (
            <Organization
              // Keyed by id so switching organization remounts the forms
              // rather than leaving the previous one's handle in the field.
              key={organizations.active.id}
              organization={organizations.active}
              onChanged={(slug) => {
                const params = window.location.search;
                window.history.replaceState(
                  null,
                  "",
                  pathForScreen("org-settings", slug) + params,
                );
                void organizations.refresh();
              }}
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
function NoOrganization({
  loading,
  notFound,
  onOpenOrganizations,
}: {
  loading: boolean;
  notFound: boolean;
  onOpenOrganizations: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {loading ? (
        <LoadingLine />
      ) : notFound ? (
        <div className="flex flex-col items-start gap-3">
          <div>
            <h1 className="text-xl font-semibold">Organization unavailable</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              It may have been renamed, removed, or no longer shared with you.
            </p>
          </div>
          <a
            href={ORGANIZATIONS_PATH}
            className="text-primary rounded-sm text-sm font-medium hover:underline"
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onOpenOrganizations();
              }
            }}
          >
            View your organizations
          </a>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          You are not in an organization yet.
        </p>
      )}
    </main>
  );
}
