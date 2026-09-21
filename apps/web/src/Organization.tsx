/**
 * Organization settings: the handle, who is in it, and who has been invited.
 *
 * Deliberately shaped like `Account.tsx`, because it answers the same
 * questions about the other principal: an organization has a permanent id and
 * a renameable public handle, exactly as a user has an id and a username, and
 * the handle form here is the counterpart of `UsernameForm`.
 *
 * What may be done depends on the caller's role, which the API returns with
 * the organization rather than being inferred in the browser. The server
 * checks it again on every write; hiding a control the plugin would refuse is
 * courtesy, not security.
 */

import type {
  MembershipDto,
  OrganizationMemberDto,
} from "@sandbox-factory/shared";
import { Check, LogOut, Trash2, UserPlus, Users } from "lucide-react";
import {
  HANDLE_MAX_LENGTH,
  isValidHandle,
  toHandleStem,
} from "sandbox-factory";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { AvatarField, UPLOAD_COMING_SOON } from "@/components/AvatarField";
import { EditableField } from "@/components/EditableField";
import { EntityAvatar } from "@/components/Avatar";
import { ErrorBanner, FormStatus } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { authClient } from "./auth";
import { JiraIcon, ProviderIcon, SlackIcon } from "./ProviderIcon";
import { useJira } from "./useJira";

/**
 * The three groups the settings page is split into, in tab order.
 *
 * Overview is first because it is the one every organization has: the other
 * two are about a team, and a personal organization shows neither.
 */
const TABS = [
  { value: "overview", label: "Overview" },
  { value: "members", label: "Members" },
  { value: "settings", label: "Settings" },
] as const;

/** Roles that may manage members and invitations. */
function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function Organization({
  organization,
  onChanged,
  onLeft,
  onOpenJira,
}: {
  /** The organization to show, with the caller's role in it. */
  organization: MembershipDto;
  /** Called after a rename, so the switcher shows the new handle. */
  onChanged: () => void;
  /** Called after leaving or deleting, so the app moves elsewhere. */
  onLeft: () => void;
  /**
   * Opens the organization's Jira page. Optional so this component can be
   * rendered in a test without the app's router.
   */
  onOpenJira?: (() => void) | undefined;
}) {
  const [members, setMembers] = useState<OrganizationMemberDto[]>([]);
  /** False until the members request has answered once; see `memberCount`. */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Controlled rather than `defaultValue`, so the member count in the handle
   * card can open the Members tab.
   */
  const [tab, setTab] = useState<string>("overview");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/orgs/${organization.id}/members`, {
        credentials: "include",
      });
      if (res.ok) {
        setMembers(
          ((await res.json()) as { members: OrganizationMemberDto[] }).members,
        );
        setLoaded(true);
      }
      setError(null);
    } catch {
      setError("Could not load this organization.");
    }
  }, [organization.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const manage = canManage(organization.role);
  /**
   * Someone's own account rather than a team. It has one member and cannot
   * gain another, so the sections about membership do not apply to it.
   */
  const personal = organization.kind === "personal";
  const owners = members.filter((entry) => entry.role === "owner");

  /** Runs a plugin call, showing its own reason when it refuses. */
  async function run(
    action: () => Promise<{ error?: { message?: string } | null }>,
    after: () => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.error !== null && result.error !== undefined) {
        // The server's wording ("You cannot leave as the only owner") is
        // something the person can act on.
        setError(result.error.message ?? "That did not work.");
        return;
      }
      after();
    } catch {
      setError("That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight">
        {organization.name}
      </h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        {personal
          ? "Your personal account\u2019s handle and connections."
          : "Your organization\u2019s handle, and who belongs to it."}
      </p>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}

      {/*
        Three tabs rather than one long column, and only for a team: a
        personal organization has no members and cannot be left, so two of
        the three would be empty. It keeps the stacked layout instead.
      */}
      {personal ? (
        <div className="mt-8 flex flex-col gap-6">
          <HandleForm
            organization={organization}
            canRename={manage}
            busy={busy}
            onBusy={setBusy}
            onSaved={onChanged}
            personal
          />

          {onOpenJira !== undefined && (
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Connections
                </CardTitle>
                <CardDescription>
                  Connect the tools this organization already works in, so their
                  work can be read and priced here.
                </CardDescription>
              </CardHeader>
              {/* Three across, two on a phone — as on the team card. */}
              <CardContent className="grid auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3">
                <JiraConnectionTile
                  organizationId={organization.id}
                  onOpenJira={onOpenJira}
                />

                {/*
                Not built yet, but named here rather than left out: the card
                is about which tools this organization connects, and an empty
                answer for the other two is still an answer.
              */}
                {COMING_SOON.map((provider) => (
                  <ConnectionTile
                    key={provider.key}
                    icon={provider.icon}
                    label={provider.label}
                    status="Coming soon"
                    disabled
                    actionLabel={`Manage ${provider.label} connections`}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="mt-8 gap-6">
          <TabsList className="w-full">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="flex flex-col gap-6">
            <HandleForm
              organization={organization}
              canRename={manage}
              busy={busy}
              onBusy={setBusy}
              onSaved={onChanged}
              // Undefined until the list arrives, which reads differently from
              // zero — every organization has at least its owner.
              memberCount={loaded ? members.length : undefined}
              onOpenMembers={() => setTab("members")}
            />

            {onOpenJira !== undefined && (
              <Card>
                <CardHeader>
                  <CardTitle role="heading" aria-level={2}>
                    Connections
                  </CardTitle>
                  <CardDescription>
                    Connect the tools this organization already works in, so
                    their work can be read and priced here.
                  </CardDescription>
                </CardHeader>
                {/*
                  Three across, and two on a phone where three squares would
                  each be too small to hold a button. `auto-rows-fr` keeps the
                  wrapped row the same height as the first, so the odd tile out
                  is not a different size from its siblings.
                */}
                <CardContent className="grid auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3">
                  <JiraConnectionTile
                    organizationId={organization.id}
                    onOpenJira={onOpenJira}
                  />

                  {/*
                  Not built yet, but named here rather than left out: the card
                  is about which tools this organization connects, and an empty
                  answer for the other two is still an answer.
                */}
                  {COMING_SOON.map((provider) => (
                    <ConnectionTile
                      key={provider.key}
                      icon={provider.icon}
                      label={provider.label}
                      status="Coming soon"
                      disabled
                      actionLabel={`Manage ${provider.label} connections`}
                    />
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="members">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Members
                </CardTitle>
                <CardDescription>
                  Everyone who can see this organization. An owner can do
                  anything here; an admin can manage members but cannot delete
                  the organization.
                </CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col gap-2">
                {members.map((entry) => {
                  // The last owner cannot be removed or demoted; the plugin
                  // refuses it, and disabling the control says so before the
                  // click rather than after.
                  const lastOwner = entry.role === "owner" && owners.length < 2;
                  return (
                    <div
                      key={entry.id}
                      className="bg-muted/35 flex items-center gap-3 rounded-lg border px-3.5 py-3"
                    >
                      {/* Seeded by `userId`, not the row's `id`: that one is
                        the membership, so seeding from it would give one
                        person a different face in every organization. */}
                      <EntityAvatar
                        id={entry.userId}
                        image={entry.image}
                        shape="circle"
                        className="size-7"
                      />

                      {/* Name over handle, matching the connection rows: the
                        handle is what identifies the person, but the name is
                        what is read first. A non-breaking space holds the
                        second line's height for somebody with no handle, so
                        rows in one list stay the same height. */}
                      <span className="flex-1">
                        <span className="block text-sm font-medium">
                          {entry.name}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {entry.username !== null ? `@${entry.username}` : " "}
                        </span>
                      </span>

                      <Badge
                        variant={
                          entry.role === "owner" ? "default" : "secondary"
                        }
                      >
                        {entry.role === "owner" && <Check />}
                        <span className="capitalize">{entry.role}</span>
                      </Badge>

                      {manage && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={busy || lastOwner}
                          title={
                            lastOwner
                              ? "An organization must keep at least one owner."
                              : undefined
                          }
                          onClick={() =>
                            void run(
                              () =>
                                authClient.organization.removeMember({
                                  memberIdOrEmail: entry.id,
                                  organizationId: organization.id,
                                }),
                              refresh,
                            )
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  );
                })}

                {/*
                Inviting under a rule in the same card: it is how this list
                grows, so it belongs to the list rather than beside it. Only
                for those who may do it — the plugin refuses the rest.
              */}
                {manage && (
                  <InviteForm
                    organizationId={organization.id}
                    busy={busy}
                    onBusy={setBusy}
                    onError={setError}
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Leaving
                </CardTitle>
                <CardDescription>
                  Leaving gives up your access to everything this organization
                  owns. An organization must always keep one owner, so the last
                  one cannot leave.
                </CardDescription>
              </CardHeader>

              <CardContent className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        authClient.organization.leave({
                          organizationId: organization.id,
                        }),
                      onLeft,
                    )
                  }
                >
                  <LogOut />
                  Leave organization
                </Button>

                {organization.role === "owner" && (
                  <DeleteOrganization
                    organization={organization}
                    busy={busy}
                    onDelete={() =>
                      void run(
                        () =>
                          authClient.organization.delete({
                            organizationId: organization.id,
                          }),
                        onLeft,
                      )
                    }
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

/**
 * The tools named on the Connections card but not yet built.
 *
 * Each carries its own mark rather than a provider id: Slack is not a sign-in
 * provider, so it has no `ProviderId` to look one up by.
 */
const COMING_SOON: { key: string; label: string; icon: ReactNode }[] = [
  { key: "github", label: "GitHub", icon: <ProviderIcon provider="github" /> },
  { key: "slack", label: "Slack", icon: <SlackIcon /> },
];

/**
 * One tool on the Connections card: its mark, its name, what is connected,
 * and the way in.
 *
 * A square tile rather than a full-width row. The three tools are siblings —
 * one of them happens to be built and the other two are not, but that is a
 * fact about today rather than a ranking — and stacked rows made the first
 * one read as the heading of a list the others belonged to. Equal squares say
 * what the card means: three tools, same standing.
 *
 * `aspect-square` rather than a fixed height, so the tiles stay square as the
 * column they sit in changes width, and `justify-between` pins the stack to
 * the middle and the Manage affordance to the foot however tall that turns
 * out to be.
 *
 * **The tile is the button.** There is one thing to do with a tool and the
 * whole square is the target, so a person aiming at a word inside a large
 * square cannot miss. That is also why "Manage" is a `span` rather than a
 * nested `Button`: a button inside a button is invalid HTML, and browsers
 * resolve it by dropping one from the accessibility tree — so the affordance
 * is drawn like a button and the tile carries the behaviour.
 */
function ConnectionTile({
  icon,
  label,
  status,
  disabled = false,
  onOpen,
  actionLabel,
}: {
  icon: ReactNode;
  label: string;
  status: string;
  /** A tool that is not built yet: named, but nothing to open. */
  disabled?: boolean | undefined;
  onOpen?: (() => void) | undefined;
  /**
   * What the tile is called to a screen reader. The visible word is "Manage"
   * on all three, so without this they are announced as three identical
   * buttons.
   */
  actionLabel: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      aria-label={actionLabel}
      /*
        `group` so the Manage affordance can pick up the tile's own hover —
        it is drawn as a button but is not one, so it has no hover of its
        own to inherit. `disabled:` rather than omitting the handler: a tool
        that is not built should look unavailable, not merely do nothing.
      */
      className="group flex aspect-square flex-col items-center justify-between rounded-lg border p-3.5 text-center transition-colors hover:bg-muted/50 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
    >
      {/*
        The mark, the name and the status as one centred stack. `flex-1` with
        `justify-center` rather than centring the tile itself: the three lines
        centre in whatever space the affordance leaves, so a tool whose status
        wraps stays balanced instead of drifting upward.
      */}
      <span className="flex flex-1 flex-col items-center justify-center">
        <span className="grid size-8 place-items-center">{icon}</span>
        <span className="mt-2.5 block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground block text-xs">{status}</span>
      </span>
      {/*
        Drawn like an outline button, and lit by the tile's hover rather than
        its own. `aria-hidden`, because the tile is already announced by
        `actionLabel` and this would otherwise repeat the word "Manage".
      */}
      <span
        aria-hidden="true"
        className="bg-background group-hover:bg-accent group-hover:text-accent-foreground w-full rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
      >
        Manage
      </span>
    </button>
  );
}

/**
 * The Jira tile, which is the only one that is real.
 *
 * It reads the organization's own connections rather than taking a count from
 * the page: `useJira` is already the per-organization read, and the home
 * screen's `useConnections` fans out over every membership, which is a
 * different question from the one this card asks.
 */
function JiraConnectionTile({
  organizationId,
  onOpenJira,
}: {
  organizationId: string;
  onOpenJira: () => void;
}) {
  const { connections, loading } = useJira(organizationId);
  // Healthy ones only, matching what the home screen counts: a connection
  // that cannot be read is not one the organization can use.
  const active = connections.filter((entry) => entry.healthy).length;

  return (
    <ConnectionTile
      // Jira's mark, not Atlassian's: this tile names the product, where the
      // sign-in screen and the account page name the account provider.
      icon={<JiraIcon />}
      label="Jira"
      // A non-breaking space rather than "0 active connections" while the
      // answer is unknown: the row does not claim none and then correct
      // itself, and the line still holds its height so nothing shifts.
      status={
        loading ? " " : `${active} active connection${active === 1 ? "" : "s"}`
      }
      onOpen={onOpenJira}
      actionLabel="Manage Jira connections"
    />
  );
}

/**
 * The handle form. The counterpart of `UsernameForm` in `Account.tsx`.
 */
function HandleForm({
  organization,
  canRename,
  busy,
  onBusy,
  onSaved,
  personal = false,
  memberCount,
  onOpenMembers,
}: {
  organization: MembershipDto;
  canRename: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
  /** Somebody's own account, which names itself rather than counting. */
  personal?: boolean | undefined;
  /**
   * How many people are in it. Undefined while the list is still loading,
   * which reads differently from zero — an organization always has its owner,
   * so zero is never a settled truth. Ignored when `personal`.
   */
  memberCount?: number | undefined;
  onOpenMembers?: (() => void) | undefined;
}) {
  /** The avatar's "not yet" notice. The handle reports its own outcome. */
  const [message, setMessage] = useState<string | null>(null);

  // `EditableField` re-seeds its own draft from the handle; this clears the
  // line under it, which would otherwise report the previous organization's
  // save after a switch.
  useEffect(() => {
    setMessage(null);
  }, [organization.slug]);

  /*
   * Returns the server's reason on a refusal and nothing on success. The
   * field shows it against the handle that was refused — "that handle is
   * taken" is only actionable next to the one that was typed.
   */
  async function save(next: string): Promise<string | void> {
    onBusy(true);
    try {
      const result = await authClient.organization.update({
        organizationId: organization.id,
        data: { slug: next },
      });
      if (result.error !== null && result.error !== undefined) {
        return result.error.message ?? "Could not save that handle.";
      }
      onSaved();
      return;
    } catch {
      return "Could not save that handle.";
    } finally {
      onBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Handle
        </CardTitle>
        <CardDescription>The organization&rsquo;s public name.</CardDescription>
      </CardHeader>

      <CardContent>
        {/*
          The picture beside the handle, which are the same fact about the
          same organization. Centred rather than pinned to the top, matching
          the account page: the handle is now one line of text at rest, so a
          top-aligned avatar would sit against nothing.
        */}
        <div className="flex items-center gap-4">
          <AvatarField
            id={organization.id}
            shape="square"
            label="organization"
            // Reuses the line that reports a rename, rather than a toast or a
            // popover: one sentence does not earn a layer or a dependency.
            onEdit={() => {
              setMessage(UPLOAD_COMING_SOON);
            }}
          />

          <EditableField
            className="min-w-0 flex-1"
            label="Organization handle"
            value={organization.slug}
            placeholder="your-org"
            busy={busy}
            canEdit={canRename}
            readOnlyReason="Only an owner or an admin can rename an organization."
            // The same rules the server applies, so a handle it would refuse
            // cannot be submitted.
            validate={(next) => isValidHandle(next)}
            onSave={(next) => save(next)}
          />
        </div>

        {/*
          Where the members are, not a statistic: the count is the label on
          the way to the tab, as the account page's count is the way to its
          organizations. Hidden until known, so it never flashes "0 members"
          at an organization that has one.

          Under the whole row rather than inside the handle column, matching
          the account page: beneath the handle it read as a fact about the
          handle.

          A personal organization says what it is instead. It has exactly one
          member and cannot gain another, so "1 member" would invite a
          question the answer to which is "never" — and there is no Members
          tab to send anyone to, which is why that case is text rather than a
          button.
        */}
        {personal ? (
          <p className="text-muted-foreground mt-5 flex w-fit items-center gap-1.5 text-sm">
            <Users className="size-4" strokeWidth={1.6} />
            Personal organization
          </p>
        ) : (
          memberCount !== undefined && (
            <button
              type="button"
              onClick={onOpenMembers}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group/members mt-5 flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <Users className="size-4" strokeWidth={1.6} />
              {/* The underline is on the words, not the button: through the
                  button it would run under the icon too. */}
              <span className="underline-offset-4 group-hover/members:underline">
                {memberCount} {memberCount === 1 ? "member" : "members"}
              </span>
            </button>
          )
        )}

        {message !== null && <FormStatus failed={false}>{message}</FormStatus>}
      </CardContent>
    </Card>
  );
}

/**
 * Invite by handle or by address.
 *
 * Nothing is emailed: the invitation appears on the invitee's account page.
 * A handle is the common case inside the product; an address reaches someone
 * who has not signed up yet.
 */
function InviteForm({
  organizationId,
  busy,
  onBusy,
  onError,
}: {
  organizationId: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    onError(null);
    setMessage(null);
    const value = draft.trim();
    // An address is anything with an `@`; everything else is a handle. The
    // server validates whichever this turns out to be.
    const body = value.includes("@") ? { email: value } : { handle: value };
    try {
      const res = await fetch(`/api/v1/orgs/${organizationId}/invitations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        onError(payload?.error ?? "Could not send that invitation.");
        return;
      }
      setDraft("");
      setMessage(`Invited ${value}. They will see it on their account page.`);
    } catch {
      onError("Could not send that invitation.");
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-2 border-t pt-4">
      {/*
        A level-three heading, not a level two: this sits inside the Members
        card now, so the same level would read as a sibling section rather
        than part of one.
      */}
      <h3 className="text-sm font-medium">Invite someone</h3>
      <p className="text-muted-foreground text-sm">
        By handle, or by the email address they sign in with. Nothing is
        emailed: the invitation waits on their account page. An address they
        have connected but not made primary will not find them.
      </p>

      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <Input
          aria-label="Handle or email address"
          placeholder="their-handle"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(null);
          }}
        />
        <Button type="submit" disabled={busy || draft.trim() === ""}>
          <UserPlus />
          Invite
        </Button>
      </form>

      {message !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Delete, behind a typed confirmation.
 *
 * Unlike signing out, this cannot be undone and takes every member's access
 * with it, so it asks for the handle to be typed rather than for one click.
 */
function DeleteOrganization({
  organization,
  busy,
  onDelete,
}: {
  organization: MembershipDto;
  busy: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-danger"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
        Delete organization
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm">
        Type <strong>{organization.slug}</strong> to confirm. This cannot be
        undone.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Type the handle to confirm"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        {/*
          `variant="destructive"` for the shape and the focus ring, repainted
          in the brand red. `focus-visible:ring-danger/20` too, or the ring
          would stay the old red against the new fill.
        */}
        <Button
          type="button"
          variant="destructive"
          className="bg-danger text-danger-foreground hover:bg-danger/90 focus-visible:ring-danger/20"
          disabled={busy || typed.trim() !== organization.slug}
          onClick={onDelete}
        >
          Delete
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setTyped("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * How many handles a create may try before giving up and reporting the
 * refusal. Collisions are rare and the suffix grows each time, so a handful is
 * plenty; the bound exists so a misread error cannot loop.
 */
const CREATE_ATTEMPTS = 5;

/**
 * Whether a create failed because the handle was already somebody else's.
 *
 * Checked on `code` and on the message, because where the client puts the
 * server's `code` is the client's business: `ORGANIZATION_SLUG_ALREADY_TAKEN`
 * is what `apps/api/src/auth.ts` throws, and the sentence is what it throws
 * with. Reading only the code would silently stop retrying if it moved, and
 * the collision would surface as an error about a handle nobody chose.
 */
function isHandleTaken(failure: { code?: string; message?: string }): boolean {
  return (
    failure.code === "ORGANIZATION_SLUG_ALREADY_TAKEN" ||
    (failure.message ?? "").toLowerCase().includes("handle is taken")
  );
}

/**
 * `acme` at attempt 2 becomes `acme-2`.
 *
 * Truncated so the result still fits `HANDLE_MAX_LENGTH` — a 30-character stem
 * with a suffix appended would be refused as too long, and the retry would
 * fail for a different reason than the one it is handling.
 */
function suffixHandle(stem: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return `${stem.slice(0, HANDLE_MAX_LENGTH - suffix.length)}${suffix}`;
}

/**
 * The create form, shown on its own screen.
 *
 * Only the name is asked for. The handle is derived from it with the same core
 * normaliser the server applies, and is editable afterwards on the settings
 * page — so the one decision here is what to call the thing, and the handle it
 * gets is a detail nobody has to weigh up front.
 */
export function CreateOrganization({
  onCreated,
  onCancel,
}: {
  onCreated: (organizationId: string, slug: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * `toHandleStem` pads a stem that would be too short and substitutes one for
   * a name that normalises to nothing, so any non-empty name yields a valid
   * handle. The submit button still checks, because that guarantee lives in
   * `packages/core` rather than here.
   */
  const slug = name.trim() === "" ? "" : toHandleStem(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      /*
       * Nobody chose this handle, so a collision is not something to report:
       * the first free `acme`, `acme-2`, `acme-3`… is taken instead. The
       * server refuses a taken handle rather than suffixing one itself, which
       * is why this asks again rather than sending once.
       *
       * Bounded, and the last attempt's refusal is shown: an unbounded retry
       * would hammer the API if the failure were something else that happened
       * to carry the same code.
       */
      for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
        const candidate = attempt === 1 ? slug : suffixHandle(slug, attempt);
        const result = await authClient.organization.create({
          name: trimmed,
          slug: candidate,
        });
        const failure = result.error;
        if (failure !== null && failure !== undefined) {
          if (isHandleTaken(failure) && attempt < CREATE_ATTEMPTS) {
            continue;
          }
          setError(failure.message ?? "Could not create that organization.");
          return;
        }
        /*
         * The slug comes back from the server rather than being assumed, so
         * the caller navigates to what was actually stored.
         */
        const created = result.data as { id?: string; slug?: string } | null;
        if (created?.id !== undefined) {
          onCreated(created.id, created.slug ?? candidate);
        }
        return;
      }
    } catch {
      setError("Could not create that organization.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight">
        New organization
      </h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        A shared workspace. You will be its owner.
      </p>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Name
          </CardTitle>
          <CardDescription>
            What people will read. A public handle is made from it, and both can
            be changed later.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            onSubmit={(event) => void submit(event)}
            className="flex flex-col gap-3"
          >
            <Input
              aria-label="Organization name"
              placeholder="Acme Robotics"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />

            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={busy || name.trim() === "" || !isValidHandle(slug)}
              >
                Create organization
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
