/**
 * Who works on a published version from outside the workspace: an owner
 * or admin makes an invite here, and its claim link is shown once, with a
 * copy button, and never again (the API keeps only its hash). Below it,
 * the version's contributors and invites, each revocable: a revoked
 * contributor loses access at once; their submissions stay listed.
 *
 * Only the sandbox's current published version takes invites; another
 * version's panel lists what it had, without the button.
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  ContributorAssignmentDto,
  ContributorInviteDto,
} from "@sandbox-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, UserPlus, X } from "lucide-react";
import { useId, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { clients, queryKeys, useUserId } from "../../data/query";
import { dateTime } from "../../lib/format";

const STATE_LABELS: Record<ContributorInviteDto["state"], string> = {
  active: "Active",
  claimed: "Claimed",
  expired: "Expired",
  revoked: "Revoked",
};

/** A claim link just made: shown this once, with when it stops working. */
interface Created {
  readonly claimUrl: string;
  readonly expiresAt: string;
}

export function SandboxContributors({
  organizationId,
  versionId,
  canInvite,
}: {
  organizationId: string;
  versionId: string;
  /** Whether this is the sandbox's current published version. */
  canInvite: boolean;
}) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const key = queryKeys.resource(
    userId,
    organizationId,
    "sandbox-contributors",
    versionId,
  );
  const listed = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      clients.sandbox.versionContributors(organizationId, versionId, signal),
  });
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  const failureText = (failure: unknown) =>
    failure instanceof ApiError
      ? failure.message
      : "Could not reach the server.";

  async function invite() {
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const made = await clients.sandbox.createContributorInvite(
        organizationId,
        versionId,
        label.trim() === "" ? {} : { label: label.trim() },
      );
      setCreated({
        claimUrl: made.claimUrl,
        expiresAt: made.invite.expiresAt,
      });
      setLabel("");
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setCreating(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("The link could not be copied. Select it and copy it instead.");
    }
  }

  /** A revoke, then the list read again; a refusal is the dialog's to say. */
  const revoke = (call: () => Promise<unknown>) => async () => {
    try {
      await call();
      await queryClient.invalidateQueries({ queryKey: key });
      return undefined;
    } catch (failure) {
      return failureText(failure);
    }
  };

  const invites = listed.data?.invites ?? [];
  const contributors = listed.data?.contributors ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="sandbox-contributors">
      <p className="text-muted-foreground text-sm text-pretty">
        Invite someone outside the workspace to this version. They sign in,
        download the project and hand in their folder; they never see the
        workspace, its other bounties or the hidden tests.
      </p>

      {canInvite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor={labelId} className="text-xs font-medium">
              Who it is for{" "}
              <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id={labelId}
              value={label}
              maxLength={100}
              placeholder="Only your workspace sees this"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={creating}>
            <UserPlus />
            {creating ? "Creating…" : "Invite contributor"}
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">
          Only the sandbox&apos;s current published version takes invites.
        </p>
      )}

      {created !== null && (
        <div
          className="bg-muted/40 flex flex-col gap-2 rounded-lg border px-4 py-3"
          data-testid="invite-link"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Link2 className="size-4" aria-hidden="true" />
              Claim link
            </p>
            <button
              type="button"
              aria-label="Dismiss the link"
              className="text-muted-foreground hover:text-foreground rounded-sm"
              onClick={() => setCreated(null)}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex gap-2">
            <Input
              readOnly
              aria-label="Claim link"
              value={created.claimUrl}
              className="font-mono text-xs md:text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy(created.claimUrl)}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Shown once: copy it now and send it to them. Whoever opens it first
            can claim it, until {dateTime(created.expiresAt)}.
          </p>
        </div>
      )}

      {listed.isPending ? (
        <p className="text-muted-foreground text-sm">Reading contributors…</p>
      ) : listed.isError ? (
        <p role="alert" className="text-destructive text-sm">
          Its contributors could not be read.
        </p>
      ) : contributors.length === 0 && invites.length === 0 ? (
        <p className="text-muted-foreground text-sm">No invites yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {contributors.length > 0 && (
            <List title="Contributors">
              {contributors.map((person) => (
                <ContributorRow
                  key={person.id}
                  person={person}
                  onRevoke={revoke(() =>
                    clients.sandbox.revokeContributor(
                      organizationId,
                      person.id,
                    ),
                  )}
                />
              ))}
            </List>
          )}
          {invites.length > 0 && (
            <List title="Invites">
              {invites.map((item) => (
                <InviteRow
                  key={item.id}
                  invite={item}
                  onRevoke={revoke(() =>
                    clients.sandbox.revokeContributorInvite(
                      organizationId,
                      item.id,
                    ),
                  )}
                />
              ))}
            </List>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function List({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs font-medium">{title}</p>
      <ul className="divide-border flex flex-col divide-y rounded-lg border">
        {children}
      </ul>
    </div>
  );
}

function ContributorRow({
  person,
  onRevoke,
}: {
  person: ContributorAssignmentDto;
  onRevoke: () => Promise<string | undefined>;
}) {
  const revoked = person.revokedAt !== null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {person.user.name}{" "}
          <span className="text-muted-foreground">{person.user.email}</span>
        </p>
        <p className="text-muted-foreground text-xs">
          {revoked
            ? `Revoked ${dateTime(person.revokedAt ?? person.createdAt)}`
            : `Joined ${dateTime(person.createdAt)}`}
        </p>
      </div>
      {revoked ? (
        <Badge variant="outline">Revoked</Badge>
      ) : (
        <ConfirmDialog
          trigger={
            <Button type="button" size="sm" variant="outline">
              Revoke
            </Button>
          }
          title={`Revoke ${person.user.name}'s access?`}
          description="They lose access to this version at once, its project and their submissions included. Their submissions stay listed here."
          confirmLabel="Revoke access"
          pendingLabel="Revoking…"
          onConfirm={onRevoke}
        />
      )}
    </li>
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: ContributorInviteDto;
  onRevoke: () => Promise<string | undefined>;
}) {
  const name = invite.label ?? invite.emailHint ?? "Unlabelled invite";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{name}</p>
        <p className="text-muted-foreground text-xs">
          {invite.claims}/{invite.maxClaims} claimed · Expires{" "}
          {dateTime(invite.expiresAt)}
          {invite.createdBy !== null && ` · By ${invite.createdBy.name}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={invite.state === "active" ? "default" : "outline"}>
          {STATE_LABELS[invite.state]}
        </Badge>
        {invite.state === "active" && (
          <ConfirmDialog
            trigger={
              <Button type="button" size="sm" variant="outline">
                Revoke
              </Button>
            }
            title="Revoke this invite?"
            description="Its link stops working. Anyone who already claimed it keeps access until you revoke them too."
            confirmLabel="Revoke invite"
            pendingLabel="Revoking…"
            onConfirm={onRevoke}
          />
        )}
      </div>
    </li>
  );
}
