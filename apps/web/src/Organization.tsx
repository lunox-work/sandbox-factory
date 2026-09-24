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
import { LogOut, Trash2, UserPlus, Users } from "lucide-react";
import {
  HANDLE_MAX_LENGTH,
  isValidHandle,
  normalizeHandle,
  toHandleStem,
} from "sandbox-factory";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { AvatarField } from "@/components/AvatarField";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EditableField } from "@/components/EditableField";
import { EntityAvatar } from "@/components/Avatar";
import { ErrorBanner, LoadingLine } from "@/components/Message";
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
import { removeAvatar, uploadAvatar, type AvatarResult } from "./avatars";
import { Connections } from "./Connections";
import type { JiraBoard } from "./useJira";
import { RateCardEditor } from "./Bounties";

/**
 * The three groups the settings page is split into, in tab order.
 *
 * Overview is first because it is the one every organization has. A personal
 * organization has no Members tab — it has one member and cannot gain
 * another — but keeps Settings, which is where its rate card lives, the same
 * as a team's.
 */
const TABS = [
  { value: "overview", label: "Overview" },
  { value: "members", label: "Members" },
  { value: "settings", label: "Settings" },
] as const;
type OrganizationTab = (typeof TABS)[number]["value"];

function tabsFor(personal: boolean) {
  return personal ? TABS.filter((tab) => tab.value !== "members") : TABS;
}

function tabFromUrl(personal: boolean): OrganizationTab {
  if (!window.location.pathname.startsWith("/o/")) {
    return "overview";
  }
  const value = new URLSearchParams(window.location.search).get("tab");
  // A personal organization has no Members tab, so a link that names it
  // (one copied from a team's page, say) opens on the overview instead.
  return tabsFor(personal).some((tab) => tab.value === value)
    ? (value as OrganizationTab)
    : "overview";
}

/** Roles that may manage members and invitations. */
function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function Organization({
  organization,
  onChanged,
  onLeft,
  onOpenBoard,
  onPictureChanged,
  viewer,
}: {
  /** The organization to show, with the caller's role in it. */
  organization: MembershipDto;
  /** Called after a rename, so the switcher shows the new handle. */
  onChanged: (slug: string) => void;
  /** Called after leaving or deleting, so the app moves elsewhere. */
  onLeft: () => void;
  /**
   * Called after the team's picture changes, so the switcher and the list
   * wear the new one. Optional: a test may leave it out.
   */
  onPictureChanged?: (() => void) | undefined;
  /**
   * Opens a board from the Jira tab under Connections. Optional so this
   * component can be rendered in a test without the app's router; without it
   * the Connections section is left out, since a board it listed could not
   * be opened.
   */
  onOpenBoard?: ((board: JiraBoard) => void) | undefined;
  /**
   * Whoever is looking. A personal organization is always the viewer's own —
   * nobody is ever in someone else's — so its picture is theirs, the one the
   * account page shows. Optional so a test may leave it out.
   */
  viewer?: { id: string; image?: string | null } | undefined;
}) {
  const [members, setMembers] = useState<OrganizationMemberDto[]>([]);
  /** False until the members request has answered once; see `memberCount`. */
  const [loaded, setLoaded] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Controlled rather than `defaultValue`, so the member count in the handle
   * card can open the Members tab.
   */
  const [tab, setTab] = useState<OrganizationTab>(() =>
    tabFromUrl(organization.kind === "personal"),
  );

  const selectTab = useCallback((next: string) => {
    const selected = next as OrganizationTab;
    setTab(selected);
    if (!window.location.pathname.startsWith("/o/")) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (selected === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", selected);
    }
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
    );
  }, []);

  useEffect(() => {
    const syncTab = () => setTab(tabFromUrl(organization.kind === "personal"));
    window.addEventListener("popstate", syncTab);
    return () => window.removeEventListener("popstate", syncTab);
  }, [organization.kind]);

  const refresh = useCallback(async () => {
    setLoaded(false);
    try {
      const res = await fetch(`/api/v1/orgs/${organization.id}/members`, {
        credentials: "include",
      });
      if (!res.ok) {
        // It used to ignore this entirely, so a 500 left an empty member list
        // and no reason for it — an organization that looked as though it had
        // lost everybody.
        setMemberError("Could not load this workspace.");
        return;
      }
      setMembers(
        ((await res.json()) as { members: OrganizationMemberDto[] }).members,
      );
      setLoaded(true);
      setMemberError(null);
    } catch {
      setMemberError("Could not load this workspace.");
    } finally {
      setLoaded(true);
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
  ): Promise<string | void> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.error !== null && result.error !== undefined) {
        // The server's wording ("You cannot leave as the only owner") is
        // something the person can act on.
        const message = result.error.message ?? "That did not work.";
        return message;
      }
      after();
    } catch {
      const message = "That did not work.";
      return message;
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
          : "Your workspace\u2019s handle, and who belongs to it."}
      </p>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}

      {/*
        Tabs rather than one long column. A personal organization has no
        members and cannot be left, so it gets Overview and Settings only —
        the rate card is in Settings for both kinds, so it is found in the
        same place whichever workspace is open.
      */}
      <Tabs value={tab} onValueChange={selectTab} className="mt-8 gap-6">
        <TabsList className="w-full">
          {tabsFor(personal).map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-6">
          {personal ? (
            <HandleForm
              organization={organization}
              canRename={manage}
              busy={busy}
              onBusy={setBusy}
              onSaved={onChanged}
              personal
              viewer={viewer}
            />
          ) : (
            <HandleForm
              organization={organization}
              canRename={manage}
              busy={busy}
              onBusy={setBusy}
              onSaved={onChanged}
              onPicture={() => onPictureChanged?.()}
              // Undefined until the list arrives, which reads differently
              // from zero — every organization has at least its owner.
              memberCount={loaded ? members.length : undefined}
              onOpenMembers={() => selectTab("members")}
            />
          )}

          {onOpenBoard !== undefined && (
            <Connections
              organizationId={organization.id}
              organizationSlug={organization.slug}
              role={organization.role}
              onOpenBoard={onOpenBoard}
            />
          )}
        </TabsContent>

        {!personal && (
          <TabsContent value="members">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  Members
                </CardTitle>
                <CardDescription>
                  Everyone who can see this workspace. An owner can do anything
                  here; an admin can manage members but cannot delete the
                  workspace.
                </CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col gap-2">
                {/* Until the list has answered once. It rendered an empty
                    card before, so an organization briefly looked as though
                    it had no members — which it never can. */}
                {!loaded && <LoadingLine />}
                {loaded && memberError !== null && (
                  <div className="flex flex-col items-start gap-2">
                    <ErrorBanner className="mt-0">{memberError}</ErrorBanner>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refresh()}
                    >
                      Try again
                    </Button>
                  </div>
                )}

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
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {entry.name}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {entry.username !== null ? `@${entry.username}` : " "}
                        </span>
                      </span>

                      <span className="ml-auto flex shrink-0 items-center gap-2.5">
                        <Badge
                          variant={
                            entry.role === "owner" ? "default" : "secondary"
                          }
                        >
                          {/* No tick: the organizations list draws the same
                              badge without one, and a filled badge already
                              says which role this is. */}
                          <span className="capitalize">{entry.role}</span>
                        </Badge>

                        {manage &&
                          // Behind a question: the rows are a column of
                          // similar names, and removing the wrong one takes
                          // away everything this organization owns from
                          // somebody who still needs it.
                          (lastOwner ? (
                            // There is no action the server could accept, so
                            // state the constraint compactly instead of
                            // rendering a disabled button and an error-shaped
                            // paragraph beside an otherwise simple row.
                            <span
                              className="text-muted-foreground whitespace-nowrap text-xs"
                              aria-label="This member is the only owner and cannot be removed"
                            >
                              Only owner
                            </span>
                          ) : (
                            <ConfirmDialog
                              trigger={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-muted-foreground hover:text-destructive"
                                  disabled={busy}
                                >
                                  Remove
                                </Button>
                              }
                              title={`Remove ${entry.name}?`}
                              description="They lose access to everything this workspace owns. You can invite them again afterwards."
                              confirmLabel="Remove"
                              busy={busy}
                              onConfirm={() =>
                                run(
                                  () =>
                                    authClient.organization.removeMember({
                                      memberIdOrEmail: entry.id,
                                      organizationId: organization.id,
                                    }),
                                  refresh,
                                )
                              }
                            />
                          ))}
                      </span>
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
        )}

        <TabsContent value="settings">
          <RateCardEditor
            organizationId={organization.id}
            role={organization.role}
          />
          {!personal && (
            <div className="mt-6">
              {/*
              Two actions that give something away, each with its own sentence
              and its own button.

              They used to share a card headed "Leaving", with delete's typed
              confirmation expanding inline beneath the leave button — so the
              words "Type acme to confirm" appeared directly under a control
              they had nothing to do with. A row each, separated by a rule,
              is what keeps a question attached to the thing it is asking
              about.
            */}
              <Card>
                <CardHeader>
                  <CardTitle role="heading" aria-level={2}>
                    Danger zone
                  </CardTitle>
                  <CardDescription>
                    Both of these give up access to everything this workspace
                    owns. A workspace must always keep one owner.
                  </CardDescription>
                </CardHeader>

                <CardContent className="divide-y">
                  <DangerRow
                    title="Leave this workspace"
                    detail="You lose access to everything it owns. The last owner cannot leave."
                  >
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                        >
                          <LogOut />
                          Leave workspace
                        </Button>
                      }
                      title={`Leave ${organization.name}?`}
                      description="You lose access to everything this workspace owns. Someone still in it would have to invite you back."
                      confirmLabel="Leave"
                      busy={busy}
                      onConfirm={() =>
                        run(
                          () =>
                            authClient.organization.leave({
                              organizationId: organization.id,
                            }),
                          onLeft,
                        )
                      }
                    />
                  </DangerRow>

                  {organization.role === "owner" && (
                    <DangerRow
                      title="Delete this workspace"
                      detail="Every member loses access, and what it owns goes with it. This cannot be undone."
                    >
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-danger hover:text-danger"
                            disabled={busy}
                          >
                            <Trash2 />
                            Delete workspace
                          </Button>
                        }
                        title={`Delete ${organization.name}?`}
                        description="Every member loses access, and everything this workspace owns goes with it. This cannot be undone."
                        confirmLabel="Delete"
                        tone="danger"
                        // The one action in the app that asks for more than a
                        // click: a mis-click here cannot be walked back.
                        typeToConfirm={organization.slug}
                        busy={busy}
                        onConfirm={() =>
                          run(
                            () =>
                              authClient.organization.delete({
                                organizationId: organization.id,
                              }),
                            onLeft,
                          )
                        }
                      />
                    </DangerRow>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </main>
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
  onPicture,
  personal = false,
  memberCount,
  onOpenMembers,
  viewer,
}: {
  organization: MembershipDto;
  canRename: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (slug: string) => void;
  /** Called with the team's new picture — null after a removal. */
  onPicture?: ((image: string | null) => void) | undefined;
  /** Somebody's own account, which names itself rather than counting. */
  personal?: boolean | undefined;
  /**
   * How many people are in it. Undefined while the list is still loading,
   * which reads differently from zero — an organization always has its owner,
   * so zero is never a settled truth. Ignored when `personal`.
   */
  memberCount?: number | undefined;
  onOpenMembers?: (() => void) | undefined;
  /** Whose picture a personal organization wears; see `Organization`. */
  viewer?: { id: string; image?: string | null } | undefined;
}) {
  /*
   * Returns the server's reason on a refusal and nothing on success. The
   * field shows it against the handle that was refused — "that handle is
   * taken" is only actionable next to the one that was typed.
   */
  /*
   * The picture after a change here, until the membership list reloads with
   * it. Undefined means "whatever the organization says".
   */
  const [picture, setPicture] = useState<string | null | undefined>(undefined);
  const avatarUrl = `/api/v1/orgs/${organization.id}/avatar`;

  /** Upload or removal; the server's reason on a refusal. */
  async function changePicture(
    action: () => Promise<AvatarResult>,
  ): Promise<string | void> {
    onBusy(true);
    try {
      const result = await action();
      if ("error" in result) {
        return result.error;
      }
      setPicture(result.image);
      onPicture?.(result.image);
      return;
    } finally {
      onBusy(false);
    }
  }

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
      onSaved(next);
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
        <CardDescription>
          {personal
            ? "Your username, which your personal pages live under."
            : "The workspace\u2019s public name."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/*
          The picture beside the handle, which are the same fact about the
          same organization. Centred rather than pinned to the top, matching
          the account page: the handle is now one line of text at rest, so a
          top-aligned avatar would sit against nothing.
        */}
        <div className="flex items-center gap-4">
          {/* A personal organization is its owner under another name, so it
              wears their face — circle, their picture — rather than a
              square identicon of its own that matches nothing else. */}
          {personal && viewer !== undefined ? (
            <AvatarField
              id={viewer.id}
              image={viewer.image}
              shape="circle"
              readOnlyReason="Your personal workspace wears your picture. Change it in Account settings."
            />
          ) : (
            <AvatarField
              id={organization.id}
              image={picture !== undefined ? picture : organization.image}
              shape="square"
              label="Change workspace picture"
              // The same people who may rename it; the server checks too.
              edit={
                canRename
                  ? {
                      busy,
                      onUpload: (file) =>
                        changePicture(() => uploadAvatar(avatarUrl, file)),
                      onRemove: () =>
                        changePicture(() => removeAvatar(avatarUrl)),
                    }
                  : undefined
              }
              readOnlyReason={
                canRename
                  ? undefined
                  : "Only an owner or an admin can change the workspace’s picture."
              }
            />
          )}

          <EditableField
            className="min-w-0 flex-1"
            label={personal ? "Handle" : "Workspace handle"}
            value={organization.slug}
            placeholder="your-org"
            busy={busy}
            // A personal organization's handle is its owner's username, kept in
            // step by the database, so there is one handle to manage and it
            // lives on the account page. The server refuses a rename here too.
            canEdit={canRename && !personal}
            readOnlyReason={
              personal
                ? "The same as your username, and changed with it."
                : "Only an owner or an admin can rename a workspace."
            }
            // The same rules the server applies, so a handle it would refuse
            // cannot be submitted.
            validate={(next) => {
              const checked = normalizeHandle(next);
              return checked.status === "ok" ? true : checked.reason;
            }}
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
            Personal workspace
          </p>
        ) : (
          memberCount !== undefined && (
            <button
              type="button"
              onClick={onOpenMembers}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group/members mt-5 flex w-fit items-center gap-1.5 rounded-sm text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
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
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    onError(null);
    setMessage(null);
    const value = draft.trim();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    const rawHandle = value.startsWith("@") ? value.slice(1) : value;
    const checked = normalizeHandle(rawHandle);
    if (!email && checked.status === "invalid") {
      setValidationError(
        value.includes("@") && !value.startsWith("@")
          ? "Enter a complete email address, or a handle such as @alex."
          : checked.reason,
      );
      onBusy(false);
      return;
    }
    setValidationError(null);
    const body = email
      ? { email: value }
      : { handle: checked.status === "ok" ? checked.handle : rawHandle };
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
        Use a handle such as @alex, or the email address they sign in with.
        Nothing is emailed: the invitation waits on their account page. An
        address they have connected but not made primary will not find them.
      </p>

      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <Input
          aria-label="Handle or email address"
          placeholder="@alex or alex@example.com"
          aria-invalid={validationError !== null}
          aria-describedby={
            validationError === null ? undefined : "invite-error"
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(null);
            setValidationError(null);
          }}
        />
        <Button type="submit" disabled={busy || draft.trim() === ""}>
          <UserPlus />
          Invite
        </Button>
      </form>

      {validationError !== null && (
        <p id="invite-error" role="alert" className="text-destructive text-sm">
          {validationError}
        </p>
      )}

      {message !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * One row in the danger zone: what it does, and the control that does it.
 *
 * The sentence sits beside the button rather than in the card's description,
 * because the card now holds two of these and one shared description could
 * only describe them vaguely. The rule between them comes from the card's
 * `divide-y`.
 */
function DangerRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    /*
      The button beside the sentence, not under it. `min-w-0` on the text and
      `shrink-0` on the control is what keeps the two on one line: without
      them the sentence claims its full width and the button wraps to the
      next row, which reads as a third item rather than as this row's action.

      It still stacks below `sm`, where there is genuinely no room for both.
    */
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{detail}</p>
      </div>
      <div className="shrink-0">{children}</div>
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
          setError(failure.message ?? "Could not create that workspace.");
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
      setError("Could not create that workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight">New workspace</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Shared with the people you invite. You will be its owner.
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
              aria-label="Workspace name"
              placeholder="Acme Robotics"
              value={name}
              // The only field on the page, and the page exists to fill it in.
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />

            {/*
              Together on the right, the way out before the commit, as in the
              confirm dialogs. Alone at the left edge, the ghost button's
              padding set its label in from the field above, so it read as
              misaligned rather than as a second action.
            */}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || name.trim() === "" || !isValidHandle(slug)}
              >
                Create workspace
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
