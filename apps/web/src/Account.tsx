/**
 * Account settings: your handle, and the providers you sign in with.
 *
 * There is no separate "email addresses" list: an address exists only because
 * a provider vouched for it, and linking is the only way to add one.
 */

import { Building2, Check, Link2, Unlink } from "lucide-react";
import type { PendingInvitationDto } from "@sandbox-factory/shared";
import { normalizeHandle } from "sandbox-factory";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AvatarField } from "@/components/AvatarField";
import { EditableField } from "@/components/EditableField";
import { ErrorBanner } from "@/components/Message";

import { PROVIDERS, authClient, useSession, type ProviderId } from "./auth";
import { ProviderIcon } from "./ProviderIcon";

interface ProvenEmail {
  id: string;
  email: string;
  /** Every provider that vouched for this address, often more than one. */
  providers: string[];
  isPrimary: boolean;
}

interface LinkedAccount {
  /**
   * Better Auth's row id. `unlinkAccount` matches on this, not on `accountId`
   * below — passing that one 400s.
   */
  id: string;
  providerId: string;
  /** The user's id at the provider, e.g. a GitHub numeric id. Display only. */
  accountId: string;
}

export function Account({
  /** Called after an invitation is accepted, so the switcher picks it up. */
  onJoined,
  /**
   * Called after an invitation is declined, so the mark on the avatar clears.
   * Accepting reports through `onJoined`, which the switcher also listens to.
   */
  onDeclined,
  /**
   * Called after a rename. The server also renames the caller's personal
   * organization, so the switcher and the rail are both a name behind until
   * they reload.
   */
  onRenamed,
  organizationCount,
  onOpenOrganizations,
}: {
  onJoined?: (() => void) | undefined;
  onDeclined?: (() => void) | undefined;
  onRenamed?: (() => void) | undefined;
  /**
   * How many organizations you belong to. Undefined while the list is still
   * loading, which reads differently from zero — everybody has at least their
   * personal one, so zero is only ever a momentary truth.
   */
  organizationCount?: number | undefined;
  onOpenOrganizations?: (() => void) | undefined;
} = {}) {
  const [emails, setEmails] = useState<ProvenEmail[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitationDto[]>([]);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  /*
   * Held here rather than read straight from the session: saving updates the
   * row, but the session this screen already has is a cached copy, so the
   * field would otherwise snap back to the old name on the next render.
   */
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The picture, from the same place the rail reads it. `/api/v1/me` does not
   * carry one, and adding it there would be a wire change for a value the
   * session already holds on every screen.
   */
  const { data: session } = useSession();

  const refresh = useCallback(async () => {
    try {
      const [emailRes, meRes, accountRes, inviteRes] = await Promise.all([
        fetch("/api/v1/me/emails", { credentials: "include" }),
        fetch("/api/v1/me", { credentials: "include" }),
        authClient.listAccounts(),
        fetch("/api/v1/me/invitations", { credentials: "include" }),
      ]);
      if (emailRes.ok) {
        const body = (await emailRes.json()) as {
          emails?: ProvenEmail[];
        } | null;
        setEmails(body?.emails ?? []);
      }
      if (meRes.ok) {
        const body = (await meRes.json()) as {
          user: { id: string; username: string | null };
        };
        setUsername(body.user.username);
        setAccountId(body.user.id);
      }
      if (inviteRes.ok) {
        const body = (await inviteRes.json()) as {
          invitations?: PendingInvitationDto[];
        } | null;
        // Defaulted, not trusted: a 200 carrying the wrong shape should show
        // no invitations rather than break the whole settings page.
        setInvitations(body?.invitations ?? []);
      }
      setAccounts((accountRes.data ?? []) as unknown as LinkedAccount[]);
      setError(null);
    } catch {
      setError("Could not load your account.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Seeded from the session, which is where the name lives until it is saved.
  const sessionName = session?.user.name;
  useEffect(() => {
    if (sessionName !== undefined) {
      setName(sessionName);
    }
  }, [sessionName]);

  const linked = new Map(
    accounts.map((account) => [account.providerId, account] as const),
  );

  async function link(provider: ProviderId) {
    setBusy(true);
    setError(null);
    try {
      await authClient.linkSocial({
        provider,
        // Back to this screen, so the new connection is visible where it was
        // started. Validated against the API's `trustedOrigins` by origin, not
        // by path, so this needs no server-side list to be kept in step.
        callbackURL: `${window.location.origin}/account`,
      });
    } catch {
      setError("Could not start linking. Please try again.");
      setBusy(false);
    }
  }

  /**
   * Runs an action on one address and reloads, showing the server's reason
   * verbatim if it refuses.
   */
  async function actOnEmail(path: string, method: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method, credentials: "include" });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        // Return rather than refresh: `refresh` clears the error on success,
        // which would wipe the message just set.
        setError(body?.error ?? "That did not work.");
        return;
      }
      await refresh();
    } catch {
      setError("That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(id: string) {
    setBusy(true);
    setError(null);
    try {
      // `id` is Better Auth's row id; see `LinkedAccount.id`.
      const result = await authClient.unlinkAccount({ accountId: id });
      if (result.error !== null && result.error !== undefined) {
        // The server's message ("can't unlink your last account") is one the
        // person can act on.
        setError(result.error.message ?? "Could not unlink that account.");
        return;
      }
      await refresh();
    } catch {
      setError("Could not unlink that account.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Accepts or declines an invitation. Both go through the plugin, which
   * checks that the caller is the address it was sent to.
   */
  async function answerInvitation(
    invitationId: string,
    action: "accept" | "reject",
  ) {
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "accept"
          ? await authClient.organization.acceptInvitation({ invitationId })
          : await authClient.organization.rejectInvitation({ invitationId });
      if (result.error !== null && result.error !== undefined) {
        setError(result.error.message ?? "Could not answer that invitation.");
        return;
      }
      await refresh();
      if (action === "accept") {
        onJoined?.();
      } else {
        onDeclined?.();
      }
    } catch {
      setError("Could not answer that invitation.");
    } finally {
      setBusy(false);
    }
  }

  const unconnected = PROVIDERS.filter((provider) => !linked.has(provider.id));

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      {/* No "back" button: Home in the left rail is the way out, and two
          affordances for one destination invite the wrong one. */}
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Your handle, and the accounts you sign in with.
      </p>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}

      <div className="mt-8 flex flex-col gap-6">
        <UsernameForm
          current={username}
          currentName={name}
          accountId={accountId}
          image={session?.user.image}
          organizationCount={organizationCount}
          onOpenOrganizations={onOpenOrganizations}
          busy={busy}
          onSaved={(next) => setUsername(next)}
          onNameSaved={(next) => {
            setName(next);
            onRenamed?.();
          }}
          onBusy={setBusy}
        />

        {invitations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                Invitations
              </CardTitle>
              <CardDescription>
                Organizations that have invited you. Accepting gives you access
                to everything they own.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-2">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="bg-muted/35 flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-3"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {invitation.organization.name}
                    <span className="text-muted-foreground ml-1.5 font-normal">
                      as {invitation.role}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void answerInvitation(invitation.id, "accept")
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void answerInvitation(invitation.id, "reject")
                    }
                  >
                    Decline
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Connected accounts
            </CardTitle>
            <CardDescription>
              Each address is proved by an account you connected.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-3">
            {emails.map((entry) => (
              <div
                key={entry.id}
                className="bg-muted/35 rounded-lg border px-3.5 py-3"
              >
                {/*
                  The address heads its block and each account proving it gets
                  its own line, so each button sits next to its provider.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-sm font-medium break-all">
                    {entry.email}
                  </span>
                  {entry.isPrimary ? (
                    <Badge variant="secondary">
                      <Check />
                      Primary
                    </Badge>
                  ) : (
                    // No "remove address" action: a connected account proves
                    // the address, so the next sign-in would restore it.
                    // Disconnecting the account is what releases it.
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void actOnEmail(
                          `/api/v1/me/emails/${entry.id}/primary`,
                          "POST",
                        )
                      }
                    >
                      Make primary
                    </Button>
                  )}
                </div>

                <ul className="mt-2.5 flex flex-col gap-1 border-t pt-2.5">
                  {entry.providers.map((providerId) => {
                    const account = linked.get(providerId);
                    return (
                      <li
                        key={providerId}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="text-muted-foreground flex items-center gap-2 text-sm">
                          <ProviderBadgeIcon providerId={providerId} />
                          {/* Providers come from the API lowercase;
                              capitalising is presentation. */}
                          <span className="capitalize">{providerId}</span>
                        </span>
                        {account !== undefined && (
                          <span className="flex flex-col items-end gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive"
                              disabled={busy || accounts.length < 2}
                              aria-describedby={
                                accounts.length < 2
                                  ? `provider-${account.id}-reason`
                                  : undefined
                              }
                              onClick={() => void unlink(account.id)}
                            >
                              <Unlink />
                              Disconnect
                            </Button>
                            {accounts.length < 2 && (
                              <span
                                id={`provider-${account.id}-reason`}
                                className="text-muted-foreground text-xs"
                              >
                                Your only sign-in method
                              </span>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {/*
              Providers with nothing connected yet, under a rule in the same
              card: connecting is a different action from managing what is
              already connected, but it is the same subject.
            */}
            {unconnected.length > 0 && (
              <div className="mt-1 flex flex-col gap-2 border-t pt-4">
                <p className="text-muted-foreground text-sm">
                  Connecting an account adds its email address and gives you
                  another way to sign in.
                </p>
                {unconnected.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5"
                  >
                    <span className="flex items-center gap-2.5 text-sm font-medium">
                      <span className="grid size-4 place-items-center">
                        <ProviderIcon provider={provider.id} />
                      </span>
                      {provider.label.replace("Continue with ", "")}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void link(provider.id)}
                    >
                      <Link2 />
                      Connect
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

/**
 * A provider's mark, when it is one the app knows.
 *
 * The API returns whatever provider vouched for an address, which need not be
 * one of `PROVIDERS` — an account linked before a provider was removed still
 * reports it. An unknown id renders nothing rather than a broken icon.
 */
function ProviderBadgeIcon({ providerId }: { providerId: string }) {
  const known = PROVIDERS.some((provider) => provider.id === providerId);
  if (!known) {
    return null;
  }
  return (
    <span className="grid size-3.5 place-items-center">
      <ProviderIcon provider={providerId as ProviderId} />
    </span>
  );
}

function UsernameForm({
  current,
  currentName,
  accountId,
  image,
  organizationCount,
  onOpenOrganizations,
  busy,
  onSaved,
  onNameSaved,
  onBusy,
}: {
  organizationCount?: number | undefined;
  onOpenOrganizations?: (() => void) | undefined;
  current: string | null;
  /** The display name, which the session carries on every screen. */
  currentName: string;
  accountId: string | null;
  /** The provider's picture, if there is one; the identicon stands in if not. */
  image?: string | null;
  busy: boolean;
  onSaved: (username: string) => void;
  onNameSaved: (name: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  /**
   * Saves the display name.
   *
   * The server also renames the caller's personal organization, which carries
   * a copy of this taken at signup — see the route. Nothing here has to know
   * about that beyond refreshing what the page shows.
   */
  /*
   * Both return the server's reason on a refusal and nothing on success. The
   * field shows it against the text that was refused; success needs no words
   * here, because the value on screen is now the new one.
   */
  async function saveName(next: string): Promise<string | void> {
    onBusy(true);
    try {
      const res = await fetch("/api/v1/me/name", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const body = (await res.json().catch(() => null)) as {
        name?: string;
        error?: string;
      } | null;
      if (res.ok && body?.name !== undefined) {
        onNameSaved(body.name);
        return;
      }
      return body?.error ?? "Could not save that name.";
    } catch {
      return "Could not save that name.";
    } finally {
      onBusy(false);
    }
  }

  async function saveUsername(next: string): Promise<string | void> {
    onBusy(true);
    try {
      const res = await fetch("/api/v1/me/username", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: next }),
      });
      const body = (await res.json().catch(() => null)) as {
        username?: string;
        error?: string;
      } | null;
      if (res.ok && body?.username !== undefined) {
        onSaved(body.username);
        return;
      }
      return body?.error ?? "Could not save that username.";
    } catch {
      return "Could not save that username.";
    } finally {
      onBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Profile
        </CardTitle>
        <CardDescription>
          What people read, and the handle they find you by.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/*
          The picture beside the name: a face and what to call it are the
          same fact, and the two read as one line. Everything else about the
          person stacks underneath, at the card's own left edge.
        */}
        <div className="flex items-center gap-4">
          {/*
            `accountId` is null until `/api/v1/me` answers. The slot is held
            open at the avatar's size rather than collapsed, or the input jumps
            left when the id lands.
          */}
          {accountId === null ? (
            <div className="size-16 shrink-0" />
          ) : (
            <AvatarField id={accountId} image={image} shape="circle" />
          )}

          {/*
            The display name beside the picture: it is what the rail, the
            menu and every member list show, so it is the label on the face.
          */}
          <EditableField
            className="min-w-0 flex-1"
            label="Name"
            value={currentName}
            placeholder="Your name"
            busy={busy}
            onSave={(next) => saveName(next)}
          />
        </div>

        {/*
          The handle below the row rather than stacked beside the picture: it
          is how somebody is addressed rather than what they are called, and
          at full width it has room for a long one without crowding the face.
        */}
        <EditableField
          className="mt-4"
          label="Username"
          value={current ?? ""}
          placeholder="your-handle"
          prefix="@"
          busy={busy}
          // The same rules the server applies, so a name it would refuse
          // cannot be submitted.
          validate={(next) => {
            const checked = normalizeHandle(next);
            return checked.status === "ok" ? true : checked.reason;
          }}
          onSave={(next) => saveUsername(next)}
        />

        {/*
          Where the handle leads, not a statistic: the count is the label on
          the way to the list. Hidden until it is known, so it does not flash
          "0 organizations" at somebody who has one.

          Under the whole row rather than inside the name column: sitting
          directly beneath the username it read as a fact about the username,
          which is the one thing it is not. The rule separates it from the two
          fields above without making it a second card.
        */}
        {organizationCount !== undefined && (
          <button
            type="button"
            onClick={onOpenOrganizations}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group/orgs mt-5 flex w-fit items-center gap-1.5 rounded-sm text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
          >
            {/* The mark the avatar menu's own "Organizations" item uses, so
                the two ways to this page read as the same destination. Sized
                here, where it sits inline with text, rather than by the
                menu's own item styling. */}
            <Building2 className="size-4" strokeWidth={1.6} />
            {/* The underline is on the words, not the button: through the
                button it would run under the icon too. */}
            <span className="underline-offset-4 group-hover/orgs:underline">
              {organizationCount}{" "}
              {organizationCount === 1 ? "organization" : "organizations"}
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
