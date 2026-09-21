/**
 * The organizations you belong to: one row each, with the role you hold and
 * the way into its settings.
 *
 * A page rather than a menu, because this is a list that carries real content
 * — names, handles, roles — and the actions on a row (open, settings) need
 * room to sit beside it. The avatar menu holds one item that lands here.
 *
 * The personal organization is listed first, under the person's own name:
 * it is the one everybody has, and it is theirs rather than shared. Its row is
 * otherwise identical — nothing below the API boundary distinguishes the two,
 * and neither should this page beyond saying which is which.
 *
 * Switching which organization is "active" is deliberately absent. Nothing
 * the app renders is owned by an organization yet, so a switcher changed a
 * tick and nothing else, which reads as a broken control. When
 * organization-owned data arrives, this page is where the switch belongs —
 * `useOrganizations` already has `select` and `clear`, both tested.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { ChevronRight, Plus } from "lucide-react";

import { EntityAvatar } from "@/components/Avatar";
import { ErrorBanner } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Personal first, then teams by name.
 *
 * Sorted here rather than by the API, which returns them oldest-membership
 * first so the list does not reshuffle when a role changes; that order is
 * still what decides the teams' relative places.
 */
function order(organizations: MembershipDto[]): MembershipDto[] {
  return [...organizations].sort(
    (a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"),
  );
}

export function Organizations({
  organizations,
  viewer,
  loading,
  error,
  onOpen,
  onCreate,
}: {
  organizations: MembershipDto[];
  /**
   * Whoever is looking. Only the personal row uses it, and that row is always
   * their own — nobody is ever listed in someone else's personal organization
   * — so no owner id has to cross the API for this.
   */
  viewer: { id: string; image?: string | null };
  loading: boolean;
  error: string | null;
  /** Opens one organization's settings. */
  onOpen: (organization: MembershipDto) => void;
  onCreate: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Organizations
          </h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Shared workspaces you belong to.
          </p>
        </div>
        {/* Beside the heading rather than under the list: creating is not the
            last item of the list, and it stays reachable when the list is
            long. */}
        <Button type="button" onClick={onCreate}>
          <Plus />
          New organization
        </Button>
      </div>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}

      <div className="mt-8">
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : organizations.length === 0 ? (
          // An empty state that says what an organization is for, since
          // someone seeing this has never made one.
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                You are not in an organization yet
              </CardTitle>
              <CardDescription>
                An organization is a shared workspace. Create one and you will
                be its owner, able to invite others and share what it owns.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" onClick={onCreate}>
                <Plus />
                New organization
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {order(organizations).map((organization) => (
              <li key={organization.id}>
                {/*
                  The whole row is the control, so the target is the size of
                  the row rather than a link at its end. A button, not a div
                  with a handler, so it is reachable by keyboard and announces
                  itself.
                */}
                <button
                  type="button"
                  onClick={() => onOpen(organization)}
                  // A fill as well as the border: the border alone moved to
                  // 15% of the foreground, which at a glance is no change at
                  // all on a row the size of this one.
                  className="bg-card hover:bg-accent/50 hover:border-foreground/15 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left shadow-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  {/*
                    The personal row wears the person's own face, not one
                    generated from the organization's id: the row above says it
                    is theirs rather than shared, and a second, differently
                    shaped face for the same person on the same screen as the
                    rail would read as two accounts.
                  */}
                  {organization.kind === "personal" ? (
                    <EntityAvatar
                      id={viewer.id}
                      image={viewer.image}
                      shape="circle"
                      className="size-9 shrink-0"
                    />
                  ) : (
                    <EntityAvatar
                      id={organization.id}
                      shape="square"
                      className="size-9 shrink-0"
                    />
                  )}

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {organization.name}
                      </span>
                      {organization.kind === "personal" && (
                        <Badge variant="secondary">Personal</Badge>
                      )}
                    </span>
                    {/* The handle, which is what a URL and an invitation use.
                        Quieter than the name: it identifies, it does not
                        label. */}
                    <span className="text-muted-foreground block truncate text-xs">
                      @{organization.slug}
                    </span>
                  </span>

                  <Badge
                    variant={
                      organization.role === "owner" ? "default" : "secondary"
                    }
                  >
                    <span className="capitalize">{organization.role}</span>
                  </Badge>

                  <ChevronRight
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
