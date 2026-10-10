import { ServerDataProvider } from "./data/query";
import {
  useLocation,
  pushLocation,
  replaceLocation,
} from "./navigation/location";
import { useEffect, useRef, useState } from "react";

import { LoadingLine, RetryableError } from "@/components/Message";
import { Page } from "@/components/Page";

import { Account } from "./Account";
import { signOut, useSession } from "./auth";
import { Breadcrumbs } from "./Breadcrumbs";
import { Home } from "./Home";
import { Onboarding } from "./Onboarding";
import { CreateOrganization, Organization } from "./Organization";
import { workspaceLabel } from "./OrganizationSwitcher";
import { Organizations } from "./Organizations";
import { RepositoryPage } from "./Repository";
import { SideNav, type Screen } from "./SideNav";
import { SignIn } from "./SignIn";
import { Bounties, BountyPage, NewBountyPage } from "./Bounties";
import { SandboxFilesPage } from "./features/sandbox/SandboxFiles";
import { newBountyUrl } from "./features/onboarding/prefill";
import { setupComplete } from "./features/onboarding/setup";
import { useWorkspaceSetup } from "./features/onboarding/useWorkspaceSetup";
import {
  bountiesUrl,
  bountyForPath,
  canonicalUrl,
  isPlainLeftClick,
  NEW_ORG_PATH,
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
   * The bounty on its own page, reported up by `BountyPage` so the trail can
   * name it. The shell renders the trail and the page owns the read the
   * name comes from, and this is the seam between the two.
   */
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
    Whether the workspace in the rail is set up yet. Read here because the
    rail and home's address both turn on it: until every onboarding step is
    done, onboarding is the one destination offered; after, home and the
    bounties are, and onboarding is not — never both. The same reads home
    and onboarding make, under the same cache keys, so the pages cost
    nothing more for it.

    Not known is not unfinished: home and bounties stay offered until this
    workspace's reads say otherwise — never on the strength of the one
    switched away from — so a set-up workspace never loses them for a
    moment.
  */
  const setup = useWorkspaceSetup(organizations.active);
  const known = setup.ownFacts && setup.facts !== null;
  const onboardingOnly =
    known && setup.facts !== null && !setupComplete(setup.facts);
  // Home is onboarding for a workspace not set up yet, and onboarding is
  // home for one that is, so the address says which. Replaced, not pushed:
  // it is the same page. The query is kept, since a consent may have come
  // back with its outcome in it.
  const landsOnOnboarding = onboardingOnly && screen === "home";
  const leavesOnboarding = known && !onboardingOnly && screen === "onboarding";
  useEffect(() => {
    if (landsOnOnboarding || leavesOnboarding)
      replaceLocation(
        (landsOnOnboarding ? pathForScreen("onboarding") : "/") +
          window.location.search +
          window.location.hash,
      );
  }, [landsOnOnboarding, leavesOnboarding]);
  // Onboarding is a landing page too: there is nothing above it to lead
  // back to.
  const landing = screen === "home" || screen === "onboarding";

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
        : screen === "onboarding"
          ? "Onboarding"
          : screen === "account"
            ? "Account"
            : screen === "organizations"
              ? "Workspaces"
              : screen === "create-org"
                ? "New workspace"
                : screen === "bounties"
                  ? "Bounties"
                  : screen === "new-bounty"
                    ? "New bounty"
                    : screen === "bounty"
                      ? (bountyName ?? "Bounty")
                      : screen === "org-repository"
                        ? (repositoryName ?? "Repository")
                        : screen === "not-found"
                          ? "Page not found"
                          : (organizations.active?.name ?? "Workspace");
    document.title = `${page} · Lunox`;
  }, [bountyName, organizations.active?.name, repositoryName, screen]);

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
   * `id` is the repository `org-repository` names. It is part of what a
   * navigation is, not a detail the target screen looks up afterwards — two
   * repositories are the same screen at different URLs.
   *
   * `tab` is the Connections tab `org-settings` opens on. The settings page
   * owns that choice once it is showing; this only says where it starts.
   */
  function navigate(
    next: Screen,
    slug?: string,
    id?: string,
    tab?: ConnectionTab,
  ) {
    // The id the current screen names, for the comparison below.
    const currentId = screen === "org-repository" ? repositoryId : undefined;
    // The same screen, but not the same page while its query holds more:
    // Bounties in the rail closes a bounty open over the list.
    if (
      next === screen &&
      slug === undefined &&
      id === currentId &&
      tab === undefined &&
      location.search === ""
    ) {
      return;
    }
    visit(pathForScreen(next, slug ?? organizations.active?.slug, id, tab));
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

      The panel is positioned, and the frame clips rather than hides. An
      absolutely positioned box with no positioned ancestor (every `sr-only`
      label is one) is placed against the document, not the panel, and one
      far down a long page made the document taller than the window, so the
      whole shell could be scrolled away. Positioned, the panel holds them;
      clipped, the frame cannot be scrolled even by focus or find-in-page.
    */
    <div className="flex min-h-dvh flex-col sm:bg-sidebar sm:h-dvh sm:flex-row sm:overflow-clip">
      <SideNav
        screen={screen}
        userId={userId}
        name={name}
        email={email}
        image={image}
        invitationCount={invitations.count}
        onboardingOnly={onboardingOnly}
        organizations={organizations}
        onSelectOrganization={(organization) => {
          // Choosing the one already shown is a no-op, not a history entry.
          if (organization.id === organizations.active?.id) {
            return;
          }
          organizations.select(organization.id);
          // A screen inside an organization moves to the same screen in the
          // chosen one, so the URL and the page agree about which is shown. A
          // repository belongs to the old organization, so it lands on the
          // new one's GitHub tab rather than on an id that is not its.
          // Screens outside any organization, the bounties of every one
          // included, stay where they are. The slug is
          // passed because `select` has not re-rendered yet — see `navigate`.
          if (screen === "org-settings") {
            navigate("org-settings", organization.slug);
          } else if (screen === "org-repository") {
            navigate("org-settings", organization.slug, undefined, "github");
          }
        }}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
      <div
        ref={contentRef}
        className={`relative min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] sm:bg-background sm:my-2 sm:mr-2 sm:overflow-y-auto sm:scrollbar-none sm:[&::-webkit-scrollbar]:hidden sm:rounded-xl sm:border sm:shadow-sm sm:pb-0 ${
          landing ? "" : "[&_[data-page]]:!pt-4 sm:[&_[data-page]]:!pt-6"
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
          spacing contract in one place. Matched by `Page`'s marker rather than
          as a direct child, so a page wrapped for a side panel (the bounty
          list) sits as close under its trail as every other.
        */}
        {!landing && (
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
        )}
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
            // Unknown while the list loads, or when it failed: "0
            // workspaces" would be said of someone who has some.
            organizationCount={
              organizations.loading || organizations.error !== null
                ? undefined
                : organizations.organizations.length
            }
            onOpenOrganizations={() => navigate("organizations")}
          />
        ) : screen === "organizations" ? (
          <Organizations
            organizations={organizations.organizations}
            viewer={{ id: userId, image }}
            loading={organizations.loading}
            error={organizations.error}
            onRetry={organizations.retry}
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
        ) : screen === "org-repository" ? (
          organizations.active === null || repositoryId === undefined ? (
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              error={organizations.error}
              onRetry={organizations.retry}
              onOpenOrganizations={() => navigate("organizations")}
              onCreateWorkspace={() => navigate("create-org")}
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
              navigate("org-settings", organization.slug, undefined, tab);
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
            // also names as its parent — or to onboarding, for a workspace
            // with no list yet.
            onCancel={() =>
              navigate(onboardingOnly ? "onboarding" : "bounties")
            }
            // Into the chosen workspace's GitHub tab, where its repositories
            // are connected. The slug is passed because `select` has not
            // re-rendered yet — see `navigate`.
            onConnectRepository={(organization) => {
              organizations.select(organization.id);
              navigate("org-settings", organization.slug, undefined, "github");
            }}
          />
        ) : screen === "not-found" ? (
          <NotFound onOpenHome={() => navigate("home")} />
        ) : screen === "org-settings" ? (
          organizations.active === null ? (
            <NoOrganization
              loading={organizations.loading}
              notFound={organizations.notFound}
              error={organizations.error}
              onRetry={organizations.retry}
              onOpenOrganizations={() => navigate("organizations")}
              onCreateWorkspace={() => navigate("create-org")}
            />
          ) : (
            <Organization
              // Keyed by id so switching organization remounts the forms
              // rather than leaving the previous one's handle in the field.
              key={organizations.active.id}
              organization={organizations.active}
              onChanged={(slug) => {
                // Through the location store, so the shell re-reads the new
                // handle now rather than once the membership refetch lands.
                replaceLocation(
                  pathForScreen("org-settings", slug) + window.location.search,
                );
                void organizations.refresh();
              }}
              viewer={{ id: userId, image }}
              // The switcher and the list read pictures from this list.
              onPictureChanged={() => void organizations.refresh()}
              onOpenBoard={(board) => {
                // A board's tickets are bounties: its view is the list,
                // narrowed to it.
                const workspace = organizations.active?.slug;
                if (workspace !== undefined) {
                  visit(
                    bountiesUrl(null, {
                      board: { workspace, boardId: board.id },
                    }),
                  );
                }
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
            <Page>
              <LoadingLine />
            </Page>
          ) : (
            // A list that failed is not one with no workspace in it; both
            // say so, and the second offers to make one.
            <NoOrganization
              loading={false}
              notFound={false}
              error={organizations.error}
              onRetry={organizations.retry}
              onOpenOrganizations={() => navigate("organizations")}
              onCreateWorkspace={() => navigate("create-org")}
            />
          )
        ) : (screen === "onboarding" && !leavesOnboarding) ||
          landsOnOnboarding ? (
          <Onboarding
            userId={userId}
            organization={organizations.active}
            onOpenSettings={(organization, tab) => {
              organizations.select(organization.id);
              navigate("org-settings", organization.slug, undefined, tab);
            }}
            onOpenRepository={(repo) => {
              setRepositoryName(repo.fullName);
              navigate("org-repository", organizations.active?.slug, repo.id);
            }}
            onWriteBounty={(prefill) => visit(newBountyUrl(prefill))}
            onOpenBounties={() => navigate("bounties")}
          />
        ) : !setup.ownFacts ? (
          /*
            Not home yet: an unfinished workspace's home is onboarding, and which
            one mounts first matters — it reads a consent's outcome from the
            address and strips it, so the other would never hear of it.
          */
          <Page>
            <LoadingLine />
          </Page>
        ) : (
          <Home
            name={name}
            organization={organizations.active}
            onOpenSettings={(organization, tab) => {
              organizations.select(organization.id);
              navigate("org-settings", organization.slug, undefined, tab);
            }}
            onWriteBounty={(prefill) => visit(newBountyUrl(prefill))}
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
  error,
  onRetry,
  onOpenOrganizations,
  onCreateWorkspace,
}: {
  loading: boolean;
  notFound: boolean;
  /** The list failed: nothing is known to be missing from it. */
  error: string | null;
  onRetry: () => void;
  onOpenOrganizations: () => void;
  onCreateWorkspace: () => void;
}) {
  return (
    <Page width="narrow">
      {loading ? (
        <LoadingLine />
      ) : error !== null ? (
        <RetryableError onRetry={onRetry}>{error}</RetryableError>
      ) : notFound ? (
        <div className="flex flex-col items-start gap-3">
          <div>
            <h1 className="text-title">Workspace unavailable</h1>
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
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            You are not in a workspace yet.
          </p>
          <a
            href={NEW_ORG_PATH}
            className="text-primary rounded-sm text-sm font-medium hover:underline"
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onCreateWorkspace();
              }
            }}
          >
            Create a workspace
          </a>
        </div>
      )}
    </Page>
  );
}

/** What an address that names no page shows, in place of guessing one. */
function NotFound({ onOpenHome }: { onOpenHome: () => void }) {
  return (
    <Page width="narrow">
      <div className="flex flex-col items-start gap-3">
        <div>
          <h1 className="text-title">Page not found</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Nothing is at this address. The link may be mistyped, or the page
            may have moved.
          </p>
        </div>
        <a
          href="/"
          className="text-primary rounded-sm text-sm font-medium hover:underline"
          onClick={(event) => {
            if (isPlainLeftClick(event)) {
              event.preventDefault();
              onOpenHome();
            }
          }}
        >
          Go home
        </a>
      </div>
    </Page>
  );
}
