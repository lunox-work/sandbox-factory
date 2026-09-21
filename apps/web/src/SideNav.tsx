/**
 * The app's left rail: brand, destinations, account.
 *
 * Modelled on a prior internal platform's rail: 56px wide, a small logo at
 * the top, full-width destination buttons marked by a left border rather than
 * a tinted tile, and the account avatar at the foot with its menu opening to
 * the right.
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
 * handset, and the convention there. The logo goes with it: it is the one item
 * that is decoration, and horizontal room is what is scarce.
 *
 * The avatar carries a mark when an invitation is waiting. Nothing is emailed,
 * and the invitation itself lives on the account page, so without it there is
 * no way to learn that one arrived.
 */

import { Building2, House } from "lucide-react";

import { cn } from "@/lib/utils";

import { UserMenu } from "./UserMenu";
import { isPlainLeftClick } from "./routes";

export type Screen =
  | "home"
  | "account"
  | "organizations"
  | "org-settings"
  | "org-jira"
  /** One connected site, under the Jira screen. Carries a connection id. */
  | "org-jira-site"
  /** One board, under a site. Carries a connection id and a board id. */
  | "org-jira-board"
  | "create-org";

export function SideNav({
  screen,
  userId,
  name,
  email,
  image,
  invitationCount = 0,
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
  onNavigate: (screen: Screen) => void;
  onSignOut: () => void;
  /**
   * Icons a page contributes to its own rail, under a divider — the reference's
   * slot for per-page tools, kept so a screen that grows some has somewhere to
   * put them. Hidden in the phone bar, where there is no room.
   */
  children?: React.ReactNode;
}) {
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
        // than laid over it.
        "sm:static sm:h-dvh sm:w-14 sm:flex-col sm:items-center sm:gap-0 sm:border-t-0 sm:border-r sm:py-3 sm:pb-3",
      )}
    >
      {/* Decorative: the rail has no room for a wordmark, and the destination
          buttons below already label everything actionable here. The dark
          variant is the same mark with a brighter gradient, which the primary
          one loses against a dark background. */}
      <a
        href="/"
        aria-label="Lunox home"
        title="Lunox"
        onClick={(event) => {
          if (isPlainLeftClick(event)) {
            event.preventDefault();
            onNavigate("home");
          }
        }}
        // It goes home like the destination below it, so it answers the
        // cursor like one. Opacity rather than a fill: the mark is a gradient
        // and a background behind it would fight the colour.
        className="hidden shrink-0 rounded-md transition-opacity hover:opacity-80 sm:block"
      >
        <picture>
          <source
            srcSet="/brand/svg/logo-gradient-dark.svg"
            media="(prefers-color-scheme: dark)"
          />
          <img
            src="/brand/svg/logo-gradient.svg"
            alt=""
            width={28}
            height={28}
            className="size-7"
          />
        </picture>
      </a>

      <div className="flex sm:mt-5 sm:w-full sm:flex-col">
        <RailButton
          label="Home"
          href="/"
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
          Organizations, which is the parent of most of the screens in this
          app and was reachable only through the avatar menu. The mark is the
          one that menu item already uses, so the two read as one destination.

          Current on every screen beneath it, not just the list: a rail that
          marks nothing while you are three levels into an organization says
          you are nowhere.
        */}
        <RailButton
          label="Organizations"
          href="/organizations"
          current={
            screen === "organizations" ||
            screen === "create-org" ||
            screen === "org-settings" ||
            screen === "org-jira" ||
            screen === "org-jira-site" ||
            screen === "org-jira-board"
          }
          onClick={() => onNavigate("organizations")}
        >
          <Building2 strokeWidth={1.6} />
        </RailButton>

        {children !== undefined && (
          <div className="hidden sm:mt-2 sm:flex sm:w-full sm:flex-col sm:border-t sm:pt-2">
            {children}
          </div>
        )}
      </div>

      {/* Pushed to the foot of the rail by `mt-auto`, so the account sits
          opposite the logo however tall it is. In the phone bar the margin is
          dropped, or it would push the avatar to the far right and split it
          from the destinations. */}
      <div className="sm:mt-auto">
        <UserMenu
          userId={userId}
          name={name}
          email={email}
          image={image}
          invitationCount={invitationCount}
          onNavigate={onNavigate}
          onAccount={() => onNavigate("account")}
          onSignOut={onSignOut}
        />
      </div>
    </nav>
  );
}

/**
 * One destination.
 *
 * The label is the accessible name and the tooltip both: the rail shows only
 * an icon, so without it the button announces as "button".
 *
 * `aria-current="page"` rather than `aria-pressed`: these switch which screen
 * is shown, they are not toggles that stay down.
 */
function RailButton({
  label,
  href,
  current,
  onClick,
  children,
}: {
  label: string;
  href: string;
  current: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      aria-label={label}
      title={label}
      onClick={(event) => {
        if (isPlainLeftClick(event)) {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "grid place-items-center transition-colors",
        "[&_svg]:size-5 [&_svg]:shrink-0",
        // Phone: a tile in the bottom bar, since a left border on a horizontal
        // bar would read as a divider between items rather than as a marker.
        "size-10 rounded-xl sm:size-auto sm:h-12 sm:w-full sm:rounded-none",
        // Tablet up: the reference's marker — a border down the leading edge,
        // transparent when inactive so the icon never shifts.
        "sm:border-l-2 sm:border-transparent",
        current
          ? "bg-primary/12 text-primary sm:bg-transparent sm:border-l-foreground sm:text-foreground"
          : // The fill is what answers the cursor. It used to be cancelled at
            // `sm` and up — exactly the widths the rail proper exists at — so
            // the destinations gave no feedback at all on a desktop.
            "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </a>
  );
}
