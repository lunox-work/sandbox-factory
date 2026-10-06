/**
 * The app's left rail: brand, destinations, account.
 *
 * Modelled on a prior internal platform's rail: 56px wide, a small logo at
 * the top, the destination buttons below it, and the account avatar at the
 * foot with its menu opening to the right. The current destination is marked
 * by a border down its leading edge, over a filled row. Workspaces sits at the
 * foot too, directly above the avatar: like the account, it is about who you
 * are rather than the work in front of you.
 *
 * Two departures from that reference, both deliberate. The rail is a flex item
 * in the shell rather than `position: fixed`, which is what lets the page
 * column scroll under its own overflow instead of the window's. And the menu
 * is Radix's, not a hand-rolled click-outside: it brings focus return, Escape,
 * arrow-key movement and `aria` wiring that the reference's version does not
 * have.
 *
 * Destinations are a closed set, so this takes the active one as a
 * discriminated value instead of reading a route. The day another screen
 * arrives, `Screen` grows a member and the compiler names every place that
 * needs updating.
 *
 * Below `sm` the rail lies down along the bottom edge — the reach zone on a
 * handset, and the convention there. The organization switcher goes with it:
 * horizontal room is what is scarce, and the pages say which organization they
 * belong to.
 *
 * The avatar carries a mark when an invitation is waiting. Nothing is emailed,
 * and the invitation itself lives on the account page, so without it there is
 * no way to learn that one arrived.
 *
 * From `sm` up the rail can be expanded to show labels beside the icons, the
 * account's name beside the avatar, and the active organization's name beside
 * its face — see `OrganizationSwitcher`. Expanded by default, and the choice is
 * remembered per browser. Every icon keeps its x position in both states, so
 * toggling only moves the edge: nothing the eye was tracking jumps.
 */

import { Box, Building2, House } from "lucide-react";
import { useEffect, useState } from "react";

import type { MembershipDto } from "@sandbox-factory/shared";

import { cn } from "@/lib/utils";

import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { UserMenu } from "./UserMenu";
import type { Organizations } from "./useOrganizations";
import { isPlainLeftClick, pathForScreen } from "./routes";

export type Screen =
  | "home"
  | "account"
  | "organizations"
  | "org-settings"
  /** One board, on a connected site. Carries a connection id and a board id. */
  | "org-jira-board"
  /** One registered repository, as a page of its own. Carries a repository id. */
  | "org-repository"
  /** Every workspace's bounties, and the proposals made from them. */
  | "bounties"
  /** The form for a new bounty, a page of its own under the bounties. */
  | "new-bounty"
  /** One bounty opened as a page of its own. Carries a workspace and an id. */
  | "bounty"
  | "create-org";

export function SideNav({
  screen,
  userId,
  name,
  email,
  image,
  invitationCount = 0,
  organizations,
  onSelectOrganization,
  onNavigate,
  onSignOut,
  children,
}: {
  screen: Screen;
  /** Passed through to the account menu, which seeds its avatar with it. */
  userId: string;
  name: string;
  email?: string | undefined;
  image?: string | null;
  /**
   * Organizations waiting for an answer. Marks the avatar, because nothing
   * else in the app says an invitation is waiting.
   */
  invitationCount?: number | undefined;
  /** For the switcher at the head of the rail. */
  organizations: Pick<Organizations, "organizations" | "active" | "loading">;
  onSelectOrganization: (organization: MembershipDto) => void;
  onNavigate: (screen: Screen) => void;
  onSignOut: () => void;
  /**
   * Icons a page contributes to its own rail, under a divider — the reference's
   * slot for per-page tools, kept so a screen that grows some has somewhere to
   * put them. Hidden in the phone bar, where there is no room.
   */
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(readExpanded);
  useEffect(() => writeExpanded(expanded), [expanded]);

  return (
    /*
      `nav` for the destinations and `aria-label` to name it: "Main" is what
      distinguishes this landmark from any navigation a page renders inside
      its own content.
    */
    <nav
      aria-label="Main"
      className={cn(
        "bg-sidebar flex shrink-0",
        // Phone: a bottom bar, its controls centred, floating over the page.
        // Fixed only here, where the alternative is a bar that scrolls away.
        "fixed inset-x-0 bottom-0 z-10 h-[calc(4rem+env(safe-area-inset-bottom))] flex-row items-start justify-center gap-6 border-t pt-3 pb-[env(safe-area-inset-bottom)]",
        // Tablet up: the rail proper, a flex item beside the content rather
        // than laid over it. No border: the shell behind the content panel is
        // the same colour, so the rail and that frame read as one surface.
        //
        // `overflow-hidden` is what lets the labels be rendered at full width
        // while the rail is still growing towards them: the edge reveals them
        // instead of them spilling over the page for the length of the
        // transition.
        "sm:static sm:h-dvh sm:flex-col sm:items-center sm:gap-0 sm:overflow-hidden sm:border-t-0 sm:py-3 sm:pb-3",
        "sm:transition-[width] sm:duration-200 sm:ease-out motion-reduce:transition-none",
        expanded ? "sm:w-56" : "sm:w-14",
      )}
    >
      {/*
        The head of the rail: the organization switcher, and the toggle.

        Expanded, the toggle sits at the far end of the row. Collapsed there is
        no row to put it in, so the toggle stands in for the switcher: the
        toggle is the only way back to the labels, and expanding brings the
        switcher back with them.

        The toggle is pinned to the slot's right edge rather than laid out
        after the switcher, so it rides the rail's width transition: collapsing
        slides it left until it lands in the face's 28px box, and expanding
        carries it back. The switcher stays mounted and fades, so nothing is
        swapped out from under the slide.

        Hidden in the phone bar: there is nothing to expand into.
      */}
      <div className="relative hidden h-8 w-full shrink-0 items-center px-3.5 sm:flex">
        <OrganizationSwitcher
          organizations={organizations.organizations}
          active={organizations.active}
          viewer={{ id: userId, image }}
          loading={organizations.loading}
          hidden={!expanded}
          onSelect={onSelectOrganization}
          onViewAll={() => onNavigate("organizations")}
        />

        {/* `aria-expanded` rather than a name that flips alone, so a screen
            reader hears it as the same control in a different state. */}
        <button
          type="button"
          aria-label="Sidebar"
          aria-expanded={expanded}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-offset-[-2px] [&_svg]:size-[18px]",
            "absolute top-0.5 right-3.5",
          )}
        >
          <SidebarToggleIcon expanded={expanded} />
        </button>
      </div>

      <div className="flex sm:mt-5 sm:w-full sm:flex-col">
        <RailButton
          label="Home"
          href="/"
          expanded={expanded}
          current={screen === "home"}
          onClick={() => onNavigate("home")}
        >
          {/* Sized by CSS, not by lucide's `size` prop, so the rail's tiles
              stay the same size from one place. Lucide's default `stroke` is
              `currentColor`, which is what lets the icon follow its button
              through hover and the current-screen state. */}
          <House strokeWidth={1.6} />
        </RailButton>

        {/*
          The bounties of every workspace: what a proposal is made from,
          whichever tool the bounty came from. Not the active workspace's
          alone, so it stays put when the switcher changes.
        */}
        <RailButton
          label="Bounties"
          href={pathForScreen("bounties")}
          expanded={expanded}
          current={
            screen === "bounties" ||
            screen === "new-bounty" ||
            screen === "bounty"
          }
          onClick={() => onNavigate("bounties")}
        >
          <Box strokeWidth={1.6} />
        </RailButton>

        {children !== undefined && (
          <div className="hidden sm:mt-2 sm:flex sm:w-full sm:flex-col sm:border-t sm:pt-2">
            {children}
          </div>
        )}
      </div>

      {/* Pushed to the foot of the rail by `mt-auto`, so the account sits
          opposite the switcher however tall it is. In the phone bar the margin is
          dropped, or it would push the avatar to the far right and split it
          from the destinations. */}
      <div className="flex sm:mt-auto sm:w-full sm:flex-col">
        {/*
          The full list of workspaces, with the create form beneath it. A row
          of its own above the avatar rather than an item in its menu, so it is
          one click from every screen — the switcher's own menu also links
          here, but that is hidden in the phone bar and while collapsed.

          A rail row rather than inside the avatar's inset wrapper, so its icon
          lines up with the destinations above it.
        */}
        <RailButton
          label="Workspaces"
          href={pathForScreen("organizations")}
          expanded={expanded}
          current={screen === "organizations" || screen === "create-org"}
          onClick={() => onNavigate("organizations")}
        >
          <Building2 strokeWidth={1.6} />
        </RailButton>

        <div className="sm:mt-1 sm:w-full sm:px-2">
          <UserMenu
            expanded={expanded}
            // The one screen its menu opens. Not one organization's own pages,
            // which the switcher above stands for, nor the workspaces list,
            // which has its own row.
            current={screen === "account"}
            userId={userId}
            name={name}
            email={email}
            image={image}
            invitationCount={invitationCount}
            onAccount={() => onNavigate("account")}
            onSignOut={onSignOut}
          />
        </div>
      </div>
    </nav>
  );
}

/**
 * The toggle's icon: a panel with a chevron that points the way the rail will
 * move.
 *
 * One drawing rather than lucide's `PanelLeftClose` and `PanelLeftOpen`
 * swapped on click, so the change can be animated: only the chevron differs
 * between those two, and here it turns in place instead of being replaced.
 * The frame and the divider are lucide's own paths, so it sits with the other
 * icons at the same weight.
 *
 * `transform-box: fill-box` turns the chevron about its own centre; an SVG
 * element's transform origin is otherwise the corner of the canvas.
 */
function SidebarToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path
        d="m16 15-3-3 3-3"
        className={cn(
          "origin-center transition-transform duration-200 ease-out [transform-box:fill-box] motion-reduce:transition-none",
          !expanded && "rotate-180",
        )}
      />
    </svg>
  );
}

/**
 * One destination.
 *
 * The label is the accessible name in both states, and the tooltip only while
 * collapsed: expanded, it is already written beside the icon.
 *
 * `aria-current="page"` rather than `aria-pressed`: these switch which screen
 * is shown, they are not toggles that stay down.
 */
function RailButton({
  label,
  href,
  expanded,
  current,
  onClick,
  children,
}: {
  label: string;
  href: string;
  expanded: boolean;
  current: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      aria-label={label}
      title={expanded ? undefined : label}
      onClick={(event) => {
        if (isPlainLeftClick(event)) {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center justify-center transition-colors",
        "[&_svg]:size-5 [&_svg]:shrink-0",
        // Phone: a tile in the bottom bar, since a left border on a horizontal
        // bar would read as a divider between items rather than as a marker.
        // Tablet up: a square-cornered row the full width of the rail.
        "size-10 rounded-xl sm:size-auto sm:h-10 sm:w-full sm:rounded-none",
        // Tablet up, the icon is pinned to the left rather than centred:
        // 2px of marker and 17px of padding centre it in the collapsed rail,
        // and keep it exactly there when the rail widens. The ring is inset
        // because the rail clips anything past its edge.
        "sm:justify-start sm:gap-3 sm:pl-[17px] sm:focus-visible:outline-offset-[-2px]",
        // Tablet up: the reference's marker — a border down the leading edge,
        // transparent always, so the icon never shifts. The marker itself is
        // the pseudo-element below, painted over the border in the brand's
        // ramp: a plain border takes one colour, not a gradient.
        "sm:relative sm:border-l-2 sm:border-transparent",
        current
          ? // The marker over a filled row: on the phone bar a tile tinted
            // with the brand, in the rail the neutral accent, the same fill
            // the cursor gives an inactive row, made solid.
            "bg-primary/12 text-primary sm:bg-accent sm:text-foreground sm:before:absolute sm:before:inset-y-0 sm:before:-left-0.5 sm:before:w-0.5 sm:before:bg-(image:--brand-gradient-vertical)"
          : // The fill is what answers the cursor. It used to be cancelled at
            // `sm` and up — exactly the widths the rail proper exists at — so
            // the destinations gave no feedback at all on a desktop. Weaker
            // than the current fill, so a hovered row never looks current.
            "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
      {expanded && (
        <span
          aria-hidden="true"
          className="hidden truncate text-sm font-medium whitespace-nowrap sm:inline"
        >
          {label}
        </span>
      )}
    </a>
  );
}

/**
 * Whether the rail was left expanded, per browser.
 *
 * Storage can be missing or throw — a private window, blocked site data — and
 * the rail must still render, so every access is guarded and the default is
 * expanded.
 */
const EXPANDED_KEY = "lunox:sidebar-expanded";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, String(expanded));
  } catch {
    // Not remembered; the rail still works for this visit.
  }
}
