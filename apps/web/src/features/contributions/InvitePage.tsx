/**
 * `/invite#lnxinv_…`, where a contributor's invite link lands.
 *
 * The secret rides in the fragment, which no server, log or `Referer`
 * receives, and leaves the address bar as soon as it is read. Signed out,
 * it is kept in this tab's session storage while the person signs in
 * (`stashInviteToken`), never in the sign-in's callback address, which
 * the API would hold; the provider's round trip comes back to `/invite`
 * in the same tab, where it is taken again and claimed once.
 *
 * A claim lands on the contribution's page. An invite revoked, expired,
 * used up or unknown reads as one "no longer valid" (the API tells them
 * apart for no one); a member of the inviting workspace is told to work
 * from the workspace instead.
 */

import { ApiError } from "@sandbox-factory/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { LoadingLine } from "@/components/Message";
import { Page } from "@/components/Page";
import { Button } from "@/components/ui/button";

import { clients, queryKeys, useUserId } from "../../data/query";
import { contributionPath, CONTRIBUTIONS_PATH } from "../../routes";

const STASH_KEY = "lunox:invite";

/** The secret a fragment carries, `lnxinv_…`; null for none. */
export function inviteTokenOf(hash: string): string | null {
  const token = decodeURIComponent(hash.replace(/^#/, "")).trim();
  return /^lnxinv_[A-Za-z0-9]{10,100}$/.test(token) ? token : null;
}

/** Drops the fragment from the address without a history entry. */
function clearFragment(): void {
  if (window.location.hash === "") return;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

/**
 * Moves the fragment's secret into this tab's session storage before a
 * signed-out person signs in, so the sign-in's callback address never
 * carries it.
 */
export function stashInviteToken(): void {
  const token = inviteTokenOf(window.location.hash);
  if (token === null) return;
  try {
    window.sessionStorage.setItem(STASH_KEY, token);
  } catch {
    // Not kept: the link opened again after signing in still works.
    return;
  }
  clearFragment();
}

/** The secret, from the address or the stash, removed from both. */
function takeInviteToken(): string | null {
  const fromHash = inviteTokenOf(window.location.hash);
  clearFragment();
  let stashed: string | null = null;
  try {
    stashed = window.sessionStorage.getItem(STASH_KEY);
    window.sessionStorage.removeItem(STASH_KEY);
  } catch {
    stashed = null;
  }
  return fromHash ?? (stashed === null ? null : inviteTokenOf(stashed));
}

type Outcome =
  | { readonly kind: "claiming" }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "member" }
  | { readonly kind: "failed"; readonly message: string };

export function InvitePage({
  onClaimed,
  onOpenHome,
}: {
  /** Lands on the claimed version's page. */
  onClaimed: (url: string) => void;
  onOpenHome: () => void;
}) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "claiming" });
  // Read once: a second render (strict mode, a remount) finds it taken.
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = takeInviteToken();

  useEffect(() => {
    const secret = token.current;
    if (secret === null || secret === undefined) {
      setOutcome({ kind: "missing" });
      return;
    }
    let live = true;
    void (async () => {
      try {
        const contribution = await clients.contributions.claimInvite(secret);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.me(userId, "contributions"),
        });
        if (live) onClaimed(contributionPath(contribution.versionId));
      } catch (failure) {
        if (!live) return;
        if (failure instanceof ApiError && failure.code === "already_member")
          setOutcome({ kind: "member" });
        else if (failure instanceof ApiError && failure.status === 404)
          setOutcome({ kind: "unavailable" });
        else
          setOutcome({
            kind: "failed",
            message:
              failure instanceof ApiError
                ? failure.message
                : "Could not reach the server.",
          });
      }
    })();
    return () => {
      live = false;
    };
    // Claimed once, for the secret read on the first render.
  }, []);

  if (outcome.kind === "claiming")
    return (
      <Page width="narrow">
        <LoadingLine>Accepting your invite…</LoadingLine>
      </Page>
    );
  const copy = {
    missing: {
      title: "This link has no invite in it",
      body: "Open the invite link again, exactly as you received it. If you already accepted it, your task is under Contributions.",
    },
    unavailable: {
      title: "This invite is no longer valid",
      body: "It may have expired, been revoked or already been used. Ask whoever sent it for a new link. Tasks you already accepted are under Contributions.",
    },
    member: {
      title: "You are already in this workspace",
      body: "Invites are for people outside the workspace. Open the task from the workspace's bounty instead.",
    },
    failed: {
      title: "The invite could not be accepted",
      body: outcome.kind === "failed" ? outcome.message : "",
    },
  }[outcome.kind];
  return (
    <Page width="narrow">
      <div
        className="flex flex-col items-start gap-4"
        data-testid="invite-outcome"
      >
        <div>
          <h1 className="text-title">{copy.title}</h1>
          <p
            role="alert"
            className="text-muted-foreground mt-1.5 max-w-prose text-sm text-pretty"
          >
            {copy.body}
          </p>
        </div>
        <div className="flex gap-2">
          {outcome.kind === "member" ? (
            <Button type="button" onClick={onOpenHome}>
              Go home
            </Button>
          ) : (
            <Button asChild variant="outline">
              <a
                href={CONTRIBUTIONS_PATH}
                onClick={(event) => {
                  event.preventDefault();
                  onClaimed(CONTRIBUTIONS_PATH);
                }}
              >
                Your contributions
              </a>
            </Button>
          )}
        </div>
      </div>
    </Page>
  );
}
