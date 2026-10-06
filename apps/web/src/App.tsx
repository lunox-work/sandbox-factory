import { ServerDataProvider } from "./data/query";
import {
  useLocation,
  pushLocation,
  replaceLocation,
} from "./navigation/location";
import { useEffect, useRef, useState } from "react";

import { LoadingLine } from "@/components/Message";

import { Account } from "./Account";
import { signOut, useSession } from "./auth";
import { Breadcrumbs } from "./Breadcrumbs";
import { Home } from "./Home";
import { HomeBoard, writeHomeBoard } from "./HomeBoard";
import { CreateOrganization, Organization } from "./Organization";
import { workspaceLabel } from "./OrganizationSwitcher";
import { Organizations } from "./Organizations";
import { JiraBoard } from "./Jira";
import { RepositoryPage } from "./Repository";
import { SideNav, type Screen } from "./SideNav";
import { SignIn } from "./SignIn";
import { Bounties, BountyPage, NewBountyPage } from "./Bounties";
import { SandboxFilesPage } from "./features/sandbox/SandboxFiles";
import {
  boardForPath,
  bountyForPath,
  canonicalUrl,
  connectionForPath,
  isPlainLeftClick,
  ORGANIZATIONS_PATH,
  pathForScreen,
  repositoryForPath,
  sandboxFilesForPath,
  type ConnectionTab,
  screenForPath,
  slugForPath,
} from "./routes";
import { useInvitations } from "./useInvitations";
import { useOrganizations } from "./useOrganizations";

export function App() {
  const { data: session, isPending } = useSession();
  const { pathname } = useLocation();
  // A version's files open in a tab of their own, outside the shell.
  const sandboxFiles = sandboxFilesForPath(pathname);

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
    <ServerDataProvider key={session.user.id} userId={session.user.id}>
      {sandboxFiles !== undefined ? (
        <SandboxFilesPage address={sandboxFiles} />
      ) : (
        <Signed
          key={session.user.id}
          userId={session.user.id}
          name={session.user.name}
          email={session.user.email}
          image={session.user.image}
        />
      )}
    </ServerDataProvider>
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
  const location = useLocation();
  const screen = screenForPath(location.pathname);
  const connectionId = connectionForPath(location.pathname);
  const boardId = boardForPath(location.pathname);
  const repositoryId = repositoryForPath(location.pathname);

  // An old `/organizations` or `/o/acme/jira` link opens the page, then the
  // address bar is brought up to date. Replaced rather than pushed: it is the
  // same page.
  useEffect(() => {
    const current = canonicalUrl(
      window.location.pathname,
      window.location.search,
    );
    if (current !== undefined) {
      replaceLocation(current + location.hash);
    }
  }, [location]);

  /**
   * The organization the app is showing. The handle in the URL wins over the
   * remembered choice, so `/o/acme/settings` opens Acme even when another was
   * active last.
   */
  const organizations = useOrganizations(slugForPath(location.pathname));
  // The workspace a bounty's own page is in, which its address names.
  const bountyAddress =
    screen === "bounty" ? bountyForPath(location.pathname) : undefined;
  const bountyOrganization =
    bountyAddress === undefined
      ? undefined
      : organizations.organizations.find(
          ({ slug }) =>
            slug.toLowerCase() === bountyAddress.workspace.toLowerCase(),
        );

  /**
   * The name of the board on screen, reported up by `JiraBoard` so the trail
   * can name it. The shell renders the trail and the page owns the list the
   * name comes from, and this is the seam between the two.
   */
  const [boardName, setBoardName] = useState<string | undefined>(undefined);

  /** The bounty on its own page, reported up by `BountyPage` as the board's is. */
  const [bountyName, setBountyName] = useState<string | undefined>(undefined);

  /** The repository on its own page, reported up by `RepositoryPage` likewise. */
  const [repositoryName, setRepositoryName] = useState<string | undefined>(
    undefined,
  );

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
            ? "Workspaces"
            : screen === "create-org"
              ? "New workspace"
              : screen === "org-jira-board"
                ? (boardName ?? "Board")
                : screen === "bounties"
                  ? "Bounties"
                  : screen === "new-bounty"
                    ? "New bounty"
                    : screen === "bounty"
                      ? (bountyName ?? "Bounty")
                      : screen === "org-repository"
                        ? (repositoryName ?? "Repository")
                        : (organizations.active?.name ?? "Workspace");
    document.title = `${page} · Lunox`;
  }, [
    boardName,
    bountyName,
    organizations.active?.name,
    repositoryName,
    screen,
  ]);

  /*
    The board on screen becomes the one home opens on, for this organization.
    Written on arrival rather than on the click that led here, so a board
    reached by URL or by Back counts the same as one opened from its site.
  */
  const activeOrganizationId = organizations.active?.id;
  const activeSlug = organizations.active?.slug;
  useEffect(() => {
    /*
      Only under the workspace the URL names. After Back, the board already
      matches the new URL while the active workspace is still the previous
      one — `useOrganizations` catches up in its own effect — and writing then
      would file one workspace's board under another. This runs again once
      they agree.
    */
    const named = slugForPath(window.location.pathname);
    if (
      screen === "org-jira-board" &&
      activeOrganizationId !== undefined &&
      activeSlug !== undefined &&
      named !== undefined &&
      named.toLowerCase() === activeSlug.toLowerCase() &&
      connectionId !== undefined &&
      boardId !== undefined
    ) {
      writeHomeBoard(userId, activeOrganizationId, { connectionId, boardId });
    }
  }, [activeOrganizationId, activeSlug, boardId, connectionId, screen, userId]);

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
  }, [location.pathname, location.search]);

  /**
   * `slug` names the organization a path should carry, for the rows on the
   * organizations page: `select` has not re-rendered yet when this runs, so
   * reading the active one here would write the *previous* organization's
   * handle into the URL.
   *
   * `id` and `board` are the site and board `org-jira-board` names, and `id`
   * alone the repository `org-repository` names. They are part of what a
   * navigation is, not a detail the target screen looks up afterwards — two
   * boards are the same screen at different URLs.
   *
   * `tab` is the Connections tab `org-settings` opens on. The settings page
   * owns that choice once it is showing; this only says where it starts.
   */
  function navigate(
    next: Screen,
    slug?: string,
    id?: string,
    board?: string,
    tab?: ConnectionTab,
  ) {
    // The id the current screen names, for the comparison below.
    const currentId = screen === "org-repository" ? repositoryId : connectionId;
    if (
      next === screen &&
      slug === undefined &&
      id === currentId &&
      board === boardId &&
      tab === undefined
    ) {
      return;
    }
    visit(
      pathForScreen(next, slug ?? organizations.active?.slug, id, board, tab),
    );
  }

  /**
   * Goes to `url` as a new page: a history entry of its own, with the scroll
   * position left behind remembered for Back and focus moved to the new
   * page's heading. What `navigate` does once it has the path, for a page
   * whose path a screen name alone cannot say, as a bounty's.
   */
  function visit(url: string) {
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
    shouldFocusPage.current = true;
    pushLocation(url);
  }

  /*
    The connections list, which home used to be. Still what home shows when
    the organization has no board yet: connecting a site is the only way on.
  */
  const homeConnections = (
    <Home
      organizations={organizations.organizations}
      organizationsLoading={organizations.loading}
      activeOrganization={organizations.active}
      onOpen={(organization) => {
        // Selecting is what makes the settings screen show this one, as on
        // the organizations page. Opened on the Jira tab, which is where
        // its sites are managed.
        organizations.select(organization.id);
        navigate(
          "org-settings",
          organization.slug,
          undefined,
          undefined,
          "jira",
        );
      }}
    />
  );

  return (
    /*
      A flex row, as in the reference: the rail is a static sibling of the
      content rather than laid over it, and the content scrolls in its own box
      so the rail cannot scroll away.

      On a phone the rail is a fixed bottom bar instead, so the row collapses
      and the padding keeps the last row clear of it.

      From `sm` up the row is painted the rail's colour and the content sits
      in it as an inset rounded panel, a thin margin on every side but the
      rail's, so the rail and the frame around the panel are one surface.

      The panel scrolls without drawing a scrollbar. One came and went as a
      page grew past the panel's height or fell back under it (a settings
      tab opened, a list arriving), and where scrollbars take up width it
      nudged the centred column sideways each time. The wheel, trackpad and
      keyboard still scroll it. Both rules, because Safari before 18.2
      ignores `scrollbar-width`.
    */
    <div className="flex min-h-dvh flex-col sm:bg-sidebar sm:h-dvh sm:flex-row sm:overflow-hidden">
      <SideNav
        screen={screen}
        userId={userId}
        name={name}
        email={email}
        image={image}
        invitationCount={invitations.count}
        organizations={organizations}
        onSelectOrganization={(organization) => {
          // Choosing the one already shown is a no-op, not a history entry.
          if (organization.id === organizations.active?.id) {
            return;
          }
          organizations.select(organization.id);
          // A screen inside an organization moves to the same screen in the
          // chosen one, so the URL and the page agree about which is shown. A
          // site or a board belongs to the old organization, so those land
          // on the new one's Jira list rather than on an id that is not its;
          // a repository likewise lands on the new one's GitHub tab.
          // Screens outside any organization, the bounties of every one
          // included, stay where they are. The slug is
          // passed because `select` has not re-rendered yet — see `navigate`.
          if (screen === "org-settings") {
            navigate("org-settings", organization.slug);
          } else if (screen === "org-jira-board") {
            navigate(
              "org-settings",
              organization.slug,
              undefined,
              undefined,
              "jira",
            );
          } else if (screen === "org-repository") {
            navigate(
              "org-settings",
              organization.slug,
              undefined,
              undefined,
              "github",
            );
          }
        }}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
      <div
        ref={contentRef}
        className={`min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] sm:bg-background sm:my-2 sm:mr-2 sm:overflow-y-auto sm:scrollbar-none sm:[&::-webkit-scrollbar]:hidden sm:rounded-[6px] sm:border sm:pb-0 ${
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
          boardName={screen === "org-jira-board" ? boardName : undefined}
          bountyName={screen === "bounty" ? bountyName : undefined}
          bountyWorkspace={
            bountyOrganization === undefined
              ? undefined
              : {
                  name: workspaceLabel(bountyOrganization),
                  slug: bountyOrganization.slug,
                }
          }
          repositoryName={
            screen === "org-repository" ? repositoryName : undefined
          }
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
              role={organizations.active.role}
            />
          )
        ) : screen === "org-repository" ? (
          organizations.active === null || repositoryId === undefined ? (
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              onOpenOrganizations={() => navigate("organizations")}
            />
          ) : (
            <RepositoryPage
              // Keyed by the repository, so moving between two remounts
              // rather than showing the previous one's runs while the new
              // ones load.
              key={`${organizations.active.id}:${repositoryId}`}
              organizationId={organizations.active.id}
              organizationSlug={organizations.active.slug}
              repoId={repositoryId}
              role={organizations.active.role}
              onName={setRepositoryName}
              // Back to the GitHub tab once it is no longer registered.
              onRemoved={() =>
                navigate(
                  "org-settings",
                  organizations.active?.slug,
                  undefined,
                  undefined,
                  "github",
                )
              }
            />
          )
        ) : screen === "bounties" ? (
          <Bounties
            organizations={organizations.organizations}
            active={organizations.active}
            organizationsLoading={organizations.loading}
            viewer={{ id: userId, image }}
            onCreate={() => navigate("new-bounty")}
            onOpenPage={visit}
          />
        ) : screen === "bounty" ? (
          <BountyPage
            organizations={organizations.organizations}
            organizationsLoading={organizations.loading}
            viewer={{ id: userId, image }}
            onTitle={setBountyName}
            onOpenBounties={() => navigate("bounties")}
            // Into the bounty's workspace's settings, where its Jira
            // accounts and repositories are connected.
            onOpenSettings={(organization, tab) => {
              organizations.select(organization.id);
              navigate(
                "org-settings",
                organization.slug,
                undefined,
                undefined,
                tab,
              );
            }}
          />
        ) : screen === "new-bounty" ? (
          <NewBountyPage
            organizations={organizations.organizations}
            active={organizations.active}
            // Until the one in the rail is known, the form would open on
            // another workspace and keep it.
            organizationsLoading={
              organizations.loading || organizations.settling
            }
            viewer={{ id: userId, image }}
            // Back to the list this form was opened from, which the trail
            // also names as its parent.
            onCancel={() => navigate("bounties")}
            // Into the chosen workspace's GitHub tab, where its repositories
            // are connected. The slug is passed because `select` has not
            // re-rendered yet — see `navigate`.
            onConnectRepository={(organization) => {
              organizations.select(organization.id);
              navigate(
                "org-settings",
                organization.slug,
                undefined,
                undefined,
                "github",
              );
            }}
          />
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
              viewer={{ id: userId, image }}
              // The switcher and the list read pictures from this list.
              onPictureChanged={() => void organizations.refresh()}
              onOpenBoard={(board) => {
                // Carried across for the same reason as from the site page.
                setBoardName(board.name);
                navigate(
                  "org-jira-board",
                  organizations.active?.slug,
                  board.connectionId,
                  board.id,
                );
              }}
              onOpenRepository={(repo) => {
                // The name is known already, so the trail and the title need
                // not wait for the page to read the list again.
                setRepositoryName(repo.fullName);
                navigate("org-repository", organizations.active?.slug, repo.id);
              }}
              onLeft={() => {
                void organizations.refresh();
                navigate("home");
              }}
            />
          )
        ) : organizations.active === null ? (
          organizations.loading || organizations.settling ? (
            <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
              <LoadingLine />
            </main>
          ) : (
            homeConnections
          )
        ) : (
          <HomeBoard
            // Keyed by the organization: switching one in the rail is a
            // different home, and the previous board must not linger.
            key={organizations.active.id}
            userId={userId}
            name={name}
            organizationId={organizations.active.id}
            organizationSlug={organizations.active.slug}
            role={organizations.active.role}
            onBoardName={setBoardName}
            onOpenBoard={(board) => {
              setBoardName(board.name);
              navigate(
                "org-jira-board",
                organizations.active?.slug,
                board.connectionId,
                board.id,
              );
            }}
            fallback={homeConnections}
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
            <h1 className="text-xl font-semibold">Workspace unavailable</h1>
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
            View your workspaces
          </a>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          You are not in a workspace yet.
        </p>
      )}
    </main>
  );
}
