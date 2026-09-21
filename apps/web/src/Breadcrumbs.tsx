/**
 * The trail above each page: where you are, and every step back up.
 *
 * The rail names destinations, not a hierarchy: a rail of icons has room for
 * Home and Organizations and no more. But most screens here sit under
 * something — an organization's Jira page is two levels down — and the only
 * ways back up were the browser's Back button and whichever link the page
 * happened to carry. Back is history, not hierarchy: arriving at
 * `/o/acme/jira` from a bookmark leaves it pointing out of the app.
 *
 * Rendered by the shell rather than by each page, so the trail cannot drift
 * between screens and a new screen gets one by describing itself in `trailFor`
 * instead of by remembering to render a component. Pages keep their own `h1`:
 * the last crumb says where you are in the hierarchy, the heading says what
 * the page is, and collapsing the two would leave the trail ending in a link
 * to itself.
 *
 * Home has no trail. A single crumb reading "Home" on the home screen is a
 * row of chrome that tells you what the rail already marks.
 */

import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Screen } from "./SideNav";

/**
 * One step. `screen` is absent on the last crumb — the page you are on is
 * text, not a link, and giving it one would offer a click that does nothing.
 *
 * `slug` travels with the crumb rather than being read at click time for the
 * same reason `navigate` takes one: the organization a crumb names is the one
 * it was built from, not whichever is active by the time it is clicked.
 */
export interface Crumb {
  label: string;
  screen?: Screen;
  slug?: string | undefined;
  /**
   * The connected site a crumb navigates to, for the screens below Jira.
   *
   * Travels with the crumb for the same reason `slug` does: the site a crumb
   * names is the one it was built from, not whichever the app happens to be
   * showing by the time it is clicked.
   */
  connectionId?: string | undefined;
}

/**
 * The organization a trail needs to name itself. Undefined while the list is
 * still loading, or when the person belongs to none.
 */
export interface TrailOrganization {
  name: string;
  slug: string;
}

const HOME: Crumb = { label: "Home", screen: "home" };
const ORGANIZATIONS: Crumb = {
  label: "Organizations",
  screen: "organizations",
};

/**
 * The trail for a screen, root first.
 *
 * Exported for the tests, which assert the shape of each trail directly rather
 * than by driving the whole shell to every screen.
 *
 * The organization screens name the organization they are showing. Until it
 * arrives the crumb is dropped rather than filled with a placeholder: a trail
 * that reads "Organizations / Loading… / Jira" shifts under the cursor the
 * moment the name lands, and the remaining crumbs still lead back up.
 */
export function trailFor(
  screen: Screen,
  organization?: TrailOrganization | undefined,
  /**
   * The connected site the last crumb names, on `org-jira-site`.
   *
   * Passed in rather than looked up, because the trail is rendered by the
   * shell and the site's name lives in a list only the page below has. Until
   * it arrives the crumb reads "Site" — the trail is one step deeper than
   * Jira whether or not the name has loaded, and dropping the last crumb
   * would mark Jira as the current page while a site is on screen.
   */
  siteName?: string | undefined,
  /** The board the last crumb names, on `org-jira-board`. See `siteName`. */
  boardName?: string | undefined,
  /** The site the board sits under, so its crumb can navigate back to it. */
  connectionId?: string | undefined,
): Crumb[] {
  switch (screen) {
    case "home":
      return [];
    case "account":
      return [HOME, { label: "Account" }];
    case "organizations":
      return [HOME, { label: "Organizations" }];
    case "create-org":
      return [HOME, ORGANIZATIONS, { label: "New organization" }];
    case "org-settings":
      /*
        The organization is what this screen is, so until its name arrives
        there is no last crumb to write. Ending the trail at "Organizations"
        instead would mark the list as the current page while an organization
        is on screen — and the page below is showing "Loading…" anyway. The
        trail appears with the name, rather than rearranging under the cursor.
      */
      return organization === undefined
        ? []
        : [HOME, ORGANIZATIONS, { label: organization.name }];
    case "org-jira":
      // Jira names itself, so this trail stands without the organization —
      // the middle crumb is the only one missing, and the steps that remain
      // still lead back up.
      return organization === undefined
        ? [HOME, ORGANIZATIONS, { label: "Jira" }]
        : [
            HOME,
            ORGANIZATIONS,
            {
              label: organization.name,
              screen: "org-settings",
              slug: organization.slug,
            },
            { label: "Jira" },
          ];
    case "org-jira-board": {
      /*
        The deepest trail there is. Built from the site's rather than restated,
        so the two cannot drift apart as the levels above them change — but
        the site's own crumb has to become a link here, since on that trail it
        was the page you were on and carried no destination.
      */
      const above = trailFor("org-jira-site", organization, siteName);
      const site = above[above.length - 1];
      return [
        ...above.slice(0, -1),
        {
          label: site?.label ?? "Site",
          screen: "org-jira-site",
          slug: organization?.slug,
          connectionId,
        },
        { label: boardName ?? "Board" },
      ];
    }
    case "org-jira-site": {
      // The Jira crumb becomes a link here, which is the way back to the list
      // of sites — and the only one, since this screen carries no other.
      const jira: Crumb = {
        label: "Jira",
        screen: "org-jira",
        slug: organization?.slug,
      };
      return organization === undefined
        ? [HOME, ORGANIZATIONS, jira, { label: siteName ?? "Site" }]
        : [
            HOME,
            ORGANIZATIONS,
            {
              label: organization.name,
              screen: "org-settings",
              slug: organization.slug,
            },
            jira,
            { label: siteName ?? "Site" },
          ];
    }
  }
}

export function Breadcrumbs({
  screen,
  organization,
  siteName,
  boardName,
  connectionId,
  onNavigate,
}: {
  screen: Screen;
  organization?: TrailOrganization | undefined;
  /** The connected site `org-jira-site` is showing; see `trailFor`. */
  siteName?: string | undefined;
  /** The board `org-jira-board` is showing; see `trailFor`. */
  boardName?: string | undefined;
  /** The connected site the board sits under; see `trailFor`. */
  connectionId?: string | undefined;
  onNavigate: (screen: Screen, slug?: string, connectionId?: string) => void;
}) {
  const crumbs = trailFor(
    screen,
    organization,
    siteName,
    boardName,
    connectionId,
  );

  // Nothing to show on home, and a bare trail of one crumb is chrome rather
  // than navigation — it names where you are without offering a way up.
  if (crumbs.length < 2) {
    return null;
  }

  return (
    /*
      `nav` with a name, because this is a second navigation landmark on the
      page and "Breadcrumb" is what distinguishes it from the rail's "Main".
      That pair of names is also what keeps two controls called Home — one
      here, one in the rail — from being an ambiguity.

      An ordered list, since the steps are a sequence and screen readers
      announce the position in it. The separators sit outside the links and are
      hidden, or every crumb would be read with a chevron glued to it.

      The column is capped and padded on this one element, exactly as each page
      caps and pads its own `main`. Splitting the two — padding here, the cap
      on the `ol` inside — is what used to misalign the trail: the padding
      applied outside the capped box, so the crumbs began 24px left of every
      heading below them.

      Only top padding, because the page below opens with its own, which
      becomes the gap between the trail and the heading. Bottom padding here
      would double it, and the negative margin trims what is left to one header
      block rather than two stacked ones — a constant here instead of a change
      to five pages, none of which should have to know whether a trail sits
      above it.
    */
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "mx-auto -mb-6 w-full px-4 pt-5 sm:-mb-8 sm:px-6 sm:pt-7",
        // The board is the one wide page, so a trail capped at the narrow
        // column would be misaligned the other way — the crumbs sitting well
        // right of the content. Read from the screen rather than taken as a
        // prop: which pages are wide is the trail's own business, and the
        // shell already tells it where it is.
        screen === "org-jira-board" ? "max-w-5xl" : "max-w-2xl",
      )}
    >
      <ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          /*
            The last crumb is the page you are on, so it is text whatever it
            carries. `trailFor` already omits `screen` there; this makes the
            component right on its own rather than by agreement with it, since
            the same organization crumb is a link mid-trail and the end of the
            trail one screen over.
          */
          const target = index === crumbs.length - 1 ? undefined : crumb.screen;
          return (
            <li key={crumb.label} className="flex items-center gap-1.5">
              {index > 0 && (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 opacity-60"
                />
              )}
              {target === undefined ? (
                /*
                  The page you are on. `aria-current="page"` is what tells a
                  screen reader which of these is the destination rather than a
                  step, and it is the same marker the rail uses.
                */
                <span
                  aria-current="page"
                  className="text-foreground font-medium"
                >
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onNavigate(target, crumb.slug, crumb.connectionId)
                  }
                  className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
