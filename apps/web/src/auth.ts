/**
 * The web app's Better Auth client.
 *
 * Same-origin in dev and production (Vite proxies /api in dev), so there is no
 * base URL and the httpOnly session cookie is sent automatically. The app never
 * touches a token, which keeps the session out of reach of injected scripts.
 * The VS Code extension cannot work this way and uses a bearer token instead.
 */

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * `organizationClient` mirrors the server's plugin: it adds
 * `authClient.organization.*` (create, update, setActive, inviteMember,
 * acceptInvitation, removeMember, leave and the rest), which is how every
 * organization *write* is made. Reads that need our own data — the
 * membership list, members with their handles, pending invitations — go
 * through `/api/v1` instead; see `useOrganizations`.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { useSession, signOut } = authClient;

/** The providers offered on the sign-in screen, in display order. */
export const PROVIDERS = [
  { id: "google", label: "Continue with Google" },
  { id: "github", label: "Continue with GitHub" },
  /**
   * Trusted for implicit linking on a weaker basis than the other two: its
   * profile carries no verified-email claim, so the API asserts one. See
   * `trustedProviders` in the API's `auth.ts`.
   */
  { id: "atlassian", label: "Continue with Atlassian" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * Where a provider sends the person back to: the page they were trying to
 * open, so a deep link survives signing in rather than landing on home.
 *
 * Same-origin by construction — the origin is this page's own — and less any
 * `?error=` from an earlier attempt, which would otherwise come back with the
 * new session and announce a failure that has since been fixed.
 */
export function signInCallbackURL(
  location: Pick<
    Location,
    "origin" | "pathname" | "search" | "hash"
  > = window.location,
): string {
  const params = new URLSearchParams(location.search);
  params.delete("error");
  const query = params.toString();
  return `${location.origin}${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`;
}

/**
 * Starts a provider redirect. `callbackURL` must be in the API's trusted
 * origins or Better Auth refuses it, which stops a crafted callback handing a
 * session to another site.
 *
 * Resolves to whether the redirect is under way. Better Auth reports a refusal
 * as `{ error }` rather than by throwing, so a caller that only caught would
 * wait forever for a navigation that is never coming.
 */
export async function signInWith(provider: ProviderId): Promise<boolean> {
  const result = await authClient.signIn.social({
    provider,
    callbackURL: signInCallbackURL(),
  });
  return result.error === null || result.error === undefined;
}
