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
 * Destinations are a closed set of two screens, so this takes the active one
 * as a discriminated value instead of reading a route. The day a third screen
 * arrives, `Screen` grows a member and the compiler names every place that
 * needs updating.
 *
 * Below `sm` the rail lies down along the bottom edge — the reach zone on a
 * handset, and the convention there. The logo goes with it: it is the one item
 * that is decoration, and horizontal room is what is scarce.
 */

import { House } from "lucide-react";

import { cn } from "@/lib/utils";

import { UserMenu } from "./UserMenu";

export type Screen =
  "todos" | "account" | "organizations" | "org-settings" | "create-org";

export function SideNav({
  screen,
  name,
  email,
  image,
  onNavigate,
  onSignOut,
  children,
}: {
  screen: Screen;
  name: string;
  email?: string | undefined;
  image?: string | null;
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
      distinguishes this landmark from the filter `nav` inside the todo list,
      which is a second navigation on the same page.
    */
    <nav
      aria-label="Main"
      className={cn(
        "bg-sidebar flex shrink-0",
        // Phone: a bottom bar, its two controls centred, floating over the
        // page. Fixed only here, where the alternative is a bar that scrolls
        // away.
        "fixed inset-x-0 bottom-0 z-10 h-16 flex-row items-center justify-center gap-6 border-t pb-[env(safe-area-inset-bottom)]",
        // Tablet up: the rail proper, a flex item beside the content rather
        // than laid over it.
        "sm:static sm:h-dvh sm:w-14 sm:flex-col sm:items-center sm:gap-0 sm:border-t-0 sm:border-r sm:py-3 sm:pb-3",
      )}
    >
      {/* Decorative: the rail has no room for a wordmark, and the destination
          buttons below already label everything actionable here. The dark
          variant is the same mark with a brighter gradient, which the primary
          one loses against a dark background. */}
      <button
        type="button"
        aria-label="Lunox home"
        title="Lunox"
        onClick={() => onNavigate("todos")}
        className="hidden shrink-0 cursor-pointer sm:block"
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
      </button>

      <div className="flex sm:mt-5 sm:w-full sm:flex-col">
        <RailButton
          label="Home"
          current={screen === "todos"}
          onClick={() => onNavigate("todos")}
        >
          {/* Sized by CSS, not by lucide's `size` prop, so the rail's tiles
              stay the same size from one place. Lucide's default `stroke` is
              `currentColor`, which is what lets the icon follow its button
              through hover and the current-screen state. */}
          <House strokeWidth={1.6} />
        </RailButton>

        {children !== undefined && (
          <div className="hidden sm:mt-2 sm:flex sm:w-full sm:flex-col sm:border-t sm:pt-2">
            {children}
          </div>
        )}
      </div>

      {/* Pushed to the foot of the rail by `mt-auto`, so the account sits
          opposite the logo however tall it is. In the phone bar the margin is
          dropped, or it would push the avatar to the far right and split the
          two controls apart. */}
      <div className="sm:mt-auto">
        <UserMenu
          name={name}
          email={email}
          image={image}
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
  current,
  onClick,
  children,
}: {
  label: string;
  current: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid cursor-pointer place-items-center transition-colors",
        "[&_svg]:size-5 [&_svg]:shrink-0",
        // Phone: a tile in the bottom bar, since a left border on a horizontal
        // bar would read as a divider between items rather than as a marker.
        "size-10 rounded-xl sm:size-auto sm:h-12 sm:w-full sm:rounded-none",
        // Tablet up: the reference's marker — a border down the leading edge,
        // transparent when inactive so the icon never shifts.
        "sm:border-l-2 sm:border-transparent",
        current
          ? "bg-primary/12 text-primary sm:bg-transparent sm:border-l-foreground sm:text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground sm:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}
