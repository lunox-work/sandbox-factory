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

import { Building2, LogOut, Settings } from "lucide-react";

import { Badge } from "@/components/ui/badge";

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

export function UserMenu({
  userId,
  name,
  email,
  image,
  invitationCount = 0,
  onNavigate,
  onAccount,
  onSignOut,
}: {
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="ring-offset-background focus-visible:ring-ring relative rounded-full transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-2 data-[state=open]:opacity-80"
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

          Ringed in the rail's own colour so it reads as a badge on the avatar
          rather than a dot floating beside it, and `aria-hidden` because the
          trigger's name already carries the count.
        */}
        {invitationCount > 0 && (
          <span
            aria-hidden="true"
            className="bg-primary ring-sidebar absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
          />
        )}
      </DropdownMenuTrigger>

      {/*
        Opens to the right, its bottom edge level with the avatar — the
        reference's placement, and the one that keeps the menu clear of the
        list it sits over. `collisionPadding` keeps it off the viewport edge
        without letting Radix flip it to the far side of the rail.

        On a phone the rail is a bottom bar, and Radix re-sides the menu itself
        rather than letting it run off screen, so there is no breakpoint here.
      */}
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        className="w-60"
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
        <DropdownMenuItem onSelect={onAccount}>
          <Settings />
          Account settings
          {invitationCount > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {invitationCount}
            </Badge>
          )}
        </DropdownMenuItem>

        {/*
          One item, not a switcher. Which organizations you are in is a list
          worth a page — it carries names, roles and the actions on each — and
          a menu that tried to hold all that competed with the account items
          around it. See `Organizations.tsx`.

          Kept even though the rail now carries the same destination: this
          menu is where somebody looks for what belongs to their account, and
          the rail's icon is unlabelled.
        */}
        <DropdownMenuItem onSelect={() => onNavigate?.("organizations")}>
          <Building2 />
          Organizations
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
