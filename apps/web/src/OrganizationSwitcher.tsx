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
 * It is the app's `Combobox`, so it opens on a search field, focused, and
 * with many organizations the one wanted is a few keystrokes away.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { ChevronsUpDown, FolderOpen } from "lucide-react";

import { EntityAvatar } from "@/components/Avatar";
import { Combobox } from "@/components/Combobox";
import { cn } from "@/lib/utils";

import { pathForScreen } from "./routes";

/**
 * What the switcher calls an organization. A personal one is "Personal"
 * rather than its name, which is the person's own: in a list of the places
 * they work, their name says whose it is but not what it is.
 */
export function workspaceLabel(organization: MembershipDto): string {
  return organization.kind === "personal" ? "Personal" : organization.name;
}

/** Whoever is looking; the owner of their personal organization. */
export interface Viewer {
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
export function WorkspaceFace({
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
export function orderWorkspaces(
  organizations: MembershipDto[],
): MembershipDto[] {
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
  const ordered = orderWorkspaces(organizations);
  return (
    /*
      Below the row and as wide as the rail's inner width, so it reads as
      the row unfolding rather than a menu that happened to open nearby.
      Its left edge is 8px into the rail, so `collisionPadding` is 8 too:
      at 12 it pushed the menu right, off centre.
    */
    <Combobox
      label="Workspaces"
      searchPlaceholder="Search workspaces…"
      emptyMessage={
        organizations.length === 0 && loading
          ? "Loading…"
          : "No workspaces match."
      }
      contentClassName="w-52 min-w-0"
      sideOffset={6}
      collisionPadding={8}
      options={ordered.map((organization) => ({
        value: organization.id,
        label: workspaceLabel(organization),
        keywords: [organization.slug],
        icon: (
          <WorkspaceFace
            organization={organization}
            viewer={viewer}
            className="size-5 shrink-0"
            squareRadius="rounded-[5px]"
          />
        ),
      }))}
      value={active?.id ?? ""}
      onValueChange={(organizationId) => {
        const chosen = organizations.find(({ id }) => id === organizationId);
        if (chosen !== undefined) onSelect(chosen);
      }}
      actions={[
        {
          key: "all",
          label: "View all workspaces",
          icon: <FolderOpen />,
          href: pathForScreen("organizations"),
          onSelect: onViewAll,
        },
      ]}
      trigger={
        <button
          type="button"
          inert={hidden}
          aria-label={
            active === null
              ? "Switch workspace"
              : `Switch workspace — ${workspaceLabel(active)}`
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
              <WorkspaceFace
                organization={active}
                viewer={viewer}
                className="size-6"
                squareRadius="rounded-[6px]"
              />
            )}
          </span>
          {active === null ? (
            loading ? (
              <span
                aria-hidden="true"
                className="skeleton h-3.5 w-20 rounded"
              />
            ) : (
              <span className="text-muted-foreground truncate text-sm">
                Workspace
              </span>
            )
          ) : (
            <span className="text-subheading truncate">
              {workspaceLabel(active)}
            </span>
          )}
          <ChevronsUpDown
            aria-hidden="true"
            strokeWidth={1.6}
            className="text-muted-foreground ml-auto size-4 shrink-0"
          />
        </button>
      }
    />
  );
}
