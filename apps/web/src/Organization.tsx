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
import { Check, LogOut, Trash2, UserPlus } from "lucide-react";
import { isValidHandle, toHandleStem } from "sandbox-factory";
import { useCallback, useEffect, useState, type FormEvent } from "react";

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

import { authClient } from "./auth";

/** Roles that may manage members and invitations. */
function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function Organization({
  organization,
  onChanged,
  onLeft,
}: {
  /** The organization to show, with the caller's role in it. */
  organization: MembershipDto;
  /** Called after a rename, so the switcher shows the new handle. */
  onChanged: () => void;
  /** Called after leaving or deleting, so the app moves elsewhere. */
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<OrganizationMemberDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/orgs/${organization.id}/members`, {
        credentials: "include",
      });
      if (res.ok) {
        setMembers(
          ((await res.json()) as { members: OrganizationMemberDto[] }).members,
        );
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
        Your organization&rsquo;s handle, and who belongs to it.
      </p>

      {error !== null && (
        <p
          role="alert"
          className="text-destructive border-destructive/35 bg-destructive/7 mt-6 rounded-lg border px-3 py-2.5 text-sm"
        >
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-6">
        <HandleForm
          organization={organization}
          canRename={manage}
          busy={busy}
          onBusy={setBusy}
          onSaved={onChanged}
        />

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Members
            </CardTitle>
            <CardDescription>
              Everyone who can see this organization. An owner can do anything
              here; an admin can manage members but cannot delete the
              organization.
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
                  className="bg-muted/35 flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-3"
                >
                  <span className="flex-1 text-sm font-medium">
                    {entry.name}
                    {entry.username !== null && (
                      <span className="text-muted-foreground ml-1.5 font-normal">
                        @{entry.username}
                      </span>
                    )}
                  </span>

                  <Badge
                    variant={entry.role === "owner" ? "default" : "secondary"}
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
          </CardContent>
        </Card>

        {manage && (
          <InviteForm
            organizationId={organization.id}
            busy={busy}
            onBusy={setBusy}
            onError={setError}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Leaving
            </CardTitle>
            <CardDescription>
              Leaving gives up your access to everything this organization owns.
              An organization must always keep one owner, so the last one cannot
              leave.
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
      </div>
    </main>
  );
}

/**
 * The handle form. The counterpart of `UsernameForm` in `Account.tsx`, down to
 * the footnote: the point both make is that the id is permanent and the
 * handle is not.
 */
function HandleForm({
  organization,
  canRename,
  busy,
  onBusy,
  onSaved,
}: {
  organization: MembershipDto;
  canRename: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(organization.slug);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Re-seed when the organization changes, or the field would keep the
  // previous one's handle after a switch.
  useEffect(() => {
    setDraft(organization.slug);
    setMessage(null);
  }, [organization.slug]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    setMessage(null);
    try {
      const result = await authClient.organization.update({
        organizationId: organization.id,
        data: { slug: draft },
      });
      if (result.error !== null && result.error !== undefined) {
        setFailed(true);
        setMessage(result.error.message ?? "Could not save that handle.");
        return;
      }
      setFailed(false);
      setMessage("Saved.");
      onSaved();
    } catch {
      setFailed(true);
      setMessage("Could not save that handle.");
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
          The organization&rsquo;s public name. You can change it whenever you
          like, as long as it is not taken.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="flex gap-2">
          <Input
            aria-label="Organization handle"
            placeholder="your-org"
            value={draft}
            disabled={!canRename}
            onChange={(event) => {
              setDraft(event.target.value);
              setMessage(null);
            }}
          />
          <Button
            type="submit"
            disabled={busy || !canRename || !isValidHandle(draft)}
          >
            Save
          </Button>
        </form>

        {!canRename && (
          <p className="text-muted-foreground mt-2 text-sm">
            Only an owner or an admin can rename an organization.
          </p>
        )}

        {message !== null && (
          <p
            role="status"
            className={
              failed
                ? "text-destructive mt-2 text-sm"
                : "text-muted-foreground mt-2 text-sm"
            }
          >
            {message}
          </p>
        )}

        <p className="text-muted-foreground mt-4 border-t pt-3 text-xs">
          Organization ID{" "}
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.72rem]">
            {organization.id}
          </code>
          <br />
          This never changes, even when you rename the handle.
        </p>
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
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Invite someone
        </CardTitle>
        <CardDescription>
          By handle, or by the email address they sign in with. Nothing is
          emailed: the invitation waits on their account page. An address they
          have connected but not made primary will not find them.
        </CardDescription>
      </CardHeader>

      <CardContent>
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
          <p role="status" className="text-muted-foreground mt-2 text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
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
        className="text-muted-foreground hover:text-destructive"
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
        <Button
          type="button"
          variant="destructive"
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
 * The create form, shown on its own screen.
 *
 * The handle is proposed from the name as it is typed, using the same core
 * normaliser the server applies, and stops following once it has been edited
 * by hand.
 */
export function CreateOrganization({
  onCreated,
  onCancel,
}: {
  onCreated: (organizationId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const proposed = edited ? slug : name.trim() === "" ? "" : toHandleStem(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.organization.create({
        name: name.trim(),
        slug: proposed,
      });
      if (result.error !== null && result.error !== undefined) {
        setError(result.error.message ?? "Could not create that organization.");
        return;
      }
      const created = result.data as { id?: string } | null;
      if (created?.id !== undefined) {
        onCreated(created.id);
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

      {error !== null && (
        <p
          role="alert"
          className="text-destructive border-destructive/35 bg-destructive/7 mt-6 rounded-lg border px-3 py-2.5 text-sm"
        >
          {error}
        </p>
      )}

      <Card className="mt-8">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Name and handle
          </CardTitle>
          <CardDescription>
            The name is what people read. The handle is the public one, and can
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
            <Input
              aria-label="Organization handle"
              placeholder="acme-robotics"
              value={proposed}
              onChange={(event) => {
                setEdited(true);
                setSlug(event.target.value);
                setError(null);
              }}
            />

            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={
                  busy || name.trim() === "" || !isValidHandle(proposed)
                }
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
