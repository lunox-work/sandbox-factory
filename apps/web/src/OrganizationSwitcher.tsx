/**
 * The organization switcher at the head of the rail: the active
 * organization's face and name, and a menu of the others.
 *
 * The face is the one the rest of the app shows for it: a personal
 * organization wears its owner's picture, round, as on the account page; a
 * team its uploaded picture, or its identicon, square. The picture is safe to
 * render because the API admits only its own avatar paths into that column;
 * see `apps/api/src/avatars/keys.ts`.
 *
 * `Organizations.tsx` once kept switching off the screen, because nothing the
 * app rendered was owned by an organization and a switcher changed a tick and
 * nothing else. That is no longer true — the Jira sites and boards are per
 * organization — so the switch lives here, where it is one click from every
 * screen. The organizations page is still where the list with roles and
 * settings lives, and where one is created; the menu links to it and holds
 * nothing else.
 *
 * The menu opens on a search field, focused, so with many organizations the
 * one wanted is a few keystrokes away. Radix's menu has typeahead of its own,
 * which would swallow those keystrokes, so the field keeps them to itself and
 * hands only ArrowDown on, into the list.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { Check, ChevronsUpDown, FolderOpen, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EntityAvatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";

import { isPlainLeftClick, pathForScreen } from "./routes";

/**
 * What the switcher calls an organization. A personal one is "Personal"
 * rather than its name, which is the person's own: in a list of the places
 * they work, their name says whose it is but not what it is.
 */
function label(organization: MembershipDto): string {
  return organization.kind === "personal" ? "Personal" : organization.name;
}

/** Whoever is looking; the owner of their personal organization. */
interface Viewer {
  id: string;
  image?: string | null | undefined;
}

/**
 * An organization's face, at a size the rail sets.
 *
 * A personal one is seeded from the viewer's id, not its own: it is always
 * theirs, and this is the face the account page and every member list show
 * for them. The square's radius is passed per size, because the shared
 * `rounded-lg` is sized for a 64px card and nearly rounds a 20px one into a
 * circle — which would make a team read as a person.
 */
function Face({
  organization,
  viewer,
  className,
  squareRadius,
}: {
  organization: MembershipDto;
  viewer: Viewer;
  className: string;
  squareRadius: string;
}) {
  return organization.kind === "personal" ? (
    <EntityAvatar
      id={viewer.id}
      image={viewer.image}
      shape="circle"
      className={className}
    />
  ) : (
    <EntityAvatar
      id={organization.id}
      image={organization.image}
      shape="square"
      className={cn(className, squareRadius)}
    />
  );
}

/** Personal first, then the rest in the API's order, as on the list page. */
function order(organizations: MembershipDto[]): MembershipDto[] {
  return [...organizations].sort(
    (a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"),
  );
}

export function OrganizationSwitcher({
  organizations,
  active,
  viewer,
  loading,
  hidden,
  onSelect,
  onViewAll,
}: {
  organizations: MembershipDto[];
  active: MembershipDto | null;
  viewer: Viewer;
  loading: boolean;
  /**
   * The rail is collapsed and the toggle stands where this was. Kept mounted
   * so it fades rather than vanishes, and `inert` so it cannot take focus.
   */
  hidden: boolean;
  onSelect: (organization: MembershipDto) => void;
  onViewAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);

  /*
   * Radix moves focus to the menu itself once it has mounted, after anything
   * `autoFocus` could do, so the field is focused a tick later instead.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => search.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const shown = order(organizations).filter(
    (organization) =>
      needle === "" ||
      label(organization).toLowerCase().includes(needle) ||
      organization.slug.toLowerCase().includes(needle),
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A fresh search each time, rather than reopening on a filtered list
        // that hides the organization the reader is looking for.
        if (!next) {
          setQuery("");
        }
      }}
    >
      <DropdownMenuTrigger
        inert={hidden}
        aria-label={
          active === null
            ? "Switch workspace"
            : `Switch workspace — ${label(active)}`
        }
        // The logo keeps the x it has in the collapsed rail: the 6px of
        // padding is taken back by the negative margin. The right margin
        // leaves room for the toggle, which is laid over this row. The ring
        // is inset because the rail clips anything past its edge.
        className={cn(
          "-ml-1.5 mr-9 flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left transition-[opacity,background-color] outline-none focus-visible:outline-offset-[-2px] data-[state=open]:bg-accent motion-reduce:transition-none",
          hidden ? "opacity-0" : "hover:bg-accent/60",
        )}
      >
        {/* 24px, the size of the account avatar at the rail's foot, centred
            in the 28px box the logo held so the collapse toggle still lands
            on it. A placeholder of the same size while the list loads, so the
            name does not jump right when the face arrives. */}
        <span className="grid size-7 shrink-0 place-items-center">
          {active === null ? (
            <span aria-hidden="true" className="skeleton size-6 rounded-md" />
          ) : (
            <Face
              organization={active}
              viewer={viewer}
              className="size-6"
              squareRadius="rounded-[6px]"
            />
          )}
        </span>
        {active === null ? (
          loading ? (
            <span aria-hidden="true" className="skeleton h-3.5 w-20 rounded" />
          ) : (
            <span className="text-muted-foreground truncate text-sm">
              Workspace
            </span>
          )
        ) : (
          <span className="truncate text-[15px] font-semibold tracking-tight">
            {label(active)}
          </span>
        )}
        <ChevronsUpDown
          aria-hidden="true"
          strokeWidth={1.6}
          className="text-muted-foreground ml-auto size-4 shrink-0"
        />
      </DropdownMenuTrigger>

      {/*
        Below the row and as wide as the rail's inner width, so it reads as
        the row unfolding rather than a menu that happened to open nearby.
        Its left edge is 8px into the rail, so `collisionPadding` is 8 too:
        at 12 it pushed the menu right, off centre.
      */}
      <DropdownMenuContent
        ref={content}
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-52"
      >
        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <Search
            aria-hidden="true"
            strokeWidth={1.6}
            className="text-muted-foreground size-4 shrink-0"
          />
          <input
            ref={search}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                content.current
                  ?.querySelector<HTMLElement>('[role="menuitem"]')
                  ?.focus();
                return;
              }
              // Escape still closes the menu, and Tab is the menu's to refuse.
              // Everything else is typing, not typeahead.
              if (event.key !== "Escape" && event.key !== "Tab") {
                event.stopPropagation();
              }
            }}
            placeholder="Search workspaces…"
            aria-label="Search workspaces"
            autoComplete="off"
            spellCheck={false}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>

        <DropdownMenuSeparator />

        {shown.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            {organizations.length === 0 && loading
              ? "Loading…"
              : "No workspaces match."}
          </p>
        ) : (
          shown.map((organization) => {
            const current = organization.id === active?.id;
            return (
              <DropdownMenuItem
                key={organization.id}
                aria-current={current ? "true" : undefined}
                onSelect={() => onSelect(organization)}
              >
                <Face
                  organization={organization}
                  viewer={viewer}
                  className="size-5 shrink-0"
                  squareRadius="rounded-[5px]"
                />
                <span className="min-w-0 flex-1 truncate">
                  {label(organization)}
                </span>
                {current && (
                  <Check aria-hidden="true" className="text-foreground" />
                )}
              </DropdownMenuItem>
            );
          })
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <a
            href={pathForScreen("organizations")}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                setOpen(false);
                onViewAll();
              }
            }}
          >
            <FolderOpen />
            View all workspaces
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
