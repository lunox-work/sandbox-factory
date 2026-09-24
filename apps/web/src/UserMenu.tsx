/**
 * The avatar at the foot of the rail, and the menu behind it.
 *
 * The menu is where the three things that used to sit in the page header and
 * footer now live: who you are signed in as, sign out, and which build this
 * is. None of them is part of the work a page is for, so none of them earns
 * permanent space on the screen.
 *
 * The build readout keeps every distinction the footer drew — release vs
 * commit, a dirty tree, and the API running a different sha — because those
 * are the facts a bug report needs. See `BuildDetails`.
 */

import { Building2, ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { EntityAvatar } from "@/components/Avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Screen } from "./SideNav";

import { BuildReadout, type LinkWrapper } from "./BuildReadout";
import { isPlainLeftClick, pathForScreen } from "./routes";

export function UserMenu({
  expanded = false,
  current = false,
  userId,
  name,
  email,
  image,
  invitationCount = 0,
  onNavigate,
  onAccount,
  onSignOut,
}: {
  /**
   * The rail is expanded, so the row shows the name beside the avatar. From
   * `sm` up only: the phone bar has no room for it.
   */
  expanded?: boolean | undefined;
  /**
   * A screen this menu leads to is showing — the account page or the
   * organizations list — so the trigger is filled like the rail's current
   * destination. Otherwise nothing in the rail says where you are.
   */
  current?: boolean | undefined;
  /** Seeds the generated avatar when there is no picture. */
  userId: string;
  name: string;
  email?: string | undefined;
  image?: string | null;
  /** Organizations waiting for an answer; see `SideNav`. */
  invitationCount?: number | undefined;
  onNavigate?: ((screen: Screen) => void) | undefined;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(
          // Phone: a round tile in the bottom bar, grown to a full 44px
          // target on a touch screen.
          "ring-offset-background focus-visible:ring-ring relative grid size-10 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:[@media(pointer:coarse)]:size-11",
          // Tablet up: a rounded row, inset 8px from the rail's edges by the
          // wrapper in `SideNav`, marked by its fill alone. 8px of padding
          // puts the 24px avatar at the centre of the collapsed rail — 8 of
          // inset, 8 of padding, 24 of avatar, 16 to spare — so toggling does
          // not move it. The ring goes inset: the rail clips anything past
          // its edge.
          "sm:flex sm:h-10 sm:w-full sm:justify-start sm:gap-3 sm:rounded-md sm:pr-3 sm:pl-2 sm:focus-visible:ring-inset sm:focus-visible:ring-offset-0",
          // The same fills as a destination: solid when current, and half
          // strength under the cursor so a hovered row never looks current.
          current
            ? "bg-accent"
            : "hover:bg-accent/60 data-[state=open]:bg-accent/60",
        )}
        aria-current={current ? "page" : undefined}
        /*
          The count is in the name, not only in the dot: a mark that exists
          purely as colour says nothing to a screen reader, and this is the
          only place in the app that an invitation is announced at all.
        */
        aria-label={
          invitationCount > 0
            ? `Account and settings — ${name}, ${invitationCount} ${
                invitationCount === 1 ? "invitation" : "invitations"
              }`
            : `Account and settings — ${name}`
        }
      >
        {/* 24px in the rail, matching the reference: small enough to read as
            chrome rather than as content. The copy inside the menu is the
            larger one, where it identifies the account. */}
        <span className="relative shrink-0">
          <EntityAvatar
            id={userId}
            image={image}
            shape="circle"
            className="size-6"
          />

          {/*
            The one mark anywhere that an invitation is waiting. Nothing is
            emailed, so without it the only way to find one is to open Account
            and look.

            On the avatar rather than the trigger, so it stays on the face
            when the trigger widens into a row. Ringed in the rail's own
            colour so it reads as a badge on the avatar rather than a dot
            floating beside it, and `aria-hidden` because the trigger's name
            already carries the count.
          */}
          {invitationCount > 0 && (
            <span
              aria-hidden="true"
              className="bg-primary ring-sidebar absolute -top-1 -right-1 size-2 rounded-full ring-2"
            />
          )}
        </span>

        {expanded && (
          <>
            <span
              aria-hidden="true"
              className="hidden min-w-0 flex-1 truncate text-left text-sm font-medium sm:block"
            >
              {name}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              strokeWidth={1.6}
              className="text-muted-foreground hidden size-4 shrink-0 sm:block"
            />
          </>
        )}
      </DropdownMenuTrigger>

      {/*
        Opens upwards from the foot of the rail, its left edge level with the
        trigger's. `collisionPadding` keeps it off the viewport edge, and is
        the rail's own 8px inset: any more and it shoves the menu right of the
        row it opens from, off centre in the rail.

        Expanded, it is exactly as wide as the account row under it, so the
        two read as one control. Collapsed, the row is only the avatar, and the
        menu keeps its own width and hangs out over the page.

        On a phone the rail is a bottom bar, where opening upwards is already
        right, so there is no breakpoint here.
      */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={
          expanded ? "w-(--radix-dropdown-menu-trigger-width)" : "w-60"
        }
      >
        {/* Name over address, the address quieter: the pair identifies the
            account, and only one of them is worth reading twice. */}
        <DropdownMenuLabel className="px-2.5 pt-1.5 pb-2.5 font-normal">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {/* `truncate` and not a wrap: an address long enough to wrap would
              change the menu's height on open, which reads as a jump. */}
          {email !== undefined && (
            <span className="text-muted-foreground mt-0.5 block truncate text-xs">
              {email}
            </span>
          )}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {/* No "Home" item: the rail is that destination, and two affordances
            for one screen invite the wrong one. */}
        {/* The count travels with the item that leads to them, so the dot on
            the avatar resolves into something specific once the menu opens. */}
        <DropdownMenuItem asChild>
          <a
            href={pathForScreen("account")}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                setOpen(false);
                onAccount();
              }
            }}
          >
            <Settings />
            Account settings
            {invitationCount > 0 && (
              <Badge variant="secondary" className="ml-auto">
                {invitationCount}
              </Badge>
            )}
          </a>
        </DropdownMenuItem>

        {/*
          One item, not a switcher. Which organizations you are in is a list
          worth a page — it carries names, roles and the actions on each — and
          a menu that tried to hold all that competed with the account items
          around it. See `Organizations.tsx`.

          The switcher at the head of the rail links to the same list; this
          menu is where somebody looks for what belongs to their account.
        */}
        <DropdownMenuItem asChild>
          <a
            href={pathForScreen("organizations")}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                setOpen(false);
                onNavigate?.("organizations");
              }
            }}
          >
            <Building2 />
            Workspaces
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Destructive styling, but no confirmation: signing out costs one
            click to undo, so a dialog would be in the way rather than a
            safeguard. */}
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <BuildDetails />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The build readout as it appears in this menu.
 *
 * The facts, and the markup that shows them, live in `BuildReadout` — the
 * signed-out screen shows the same readout and there is no avatar there. All
 * this adds is the one thing that is specific to being inside a menu: the
 * links are wrapped as `DropdownMenuItem`s.
 *
 * Radix walks the arrow keys over the items it knows about and its focus scope
 * holds Tab inside the open menu, so a link that is neither is one no keyboard
 * can reach. `asChild` renders the anchor itself, so it stays a link.
 *
 * `onSelect` is left to its default, which closes the menu: following a link
 * navigates away, and a menu left open over the new page is the surprise.
 * Both open in a new tab, where the close is what returns focus to the
 * trigger.
 *
 * Exported for its own tests, which mount it in a bare open menu rather than
 * through the avatar: what they check is this subtree's content, not the menu
 * around it. `nav.test.tsx` is what pins the readout to the avatar's menu.
 */
export function BuildDetails() {
  return <BuildReadout wrapLink={asMenuItem} className="px-2 py-1.5" />;
}

/**
 * Wraps a link as a menu item, keeping none of the default item padding: the
 * readout lays its own rows out, and the item is only here to carry focus.
 */
const asMenuItem: LinkWrapper = (link) => (
  <DropdownMenuItem asChild className="h-auto p-0 focus:bg-transparent">
    {link}
  </DropdownMenuItem>
);
