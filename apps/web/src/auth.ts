/**
 * The web app's Better Auth client.
 *
 * Same-origin in both dev and production — Vite proxies /api to the API in dev
 * — so there is no base URL to configure and the session cookie is sent
 * automatically. That is the whole reason the web app never touches a token:
 * the browser holds an httpOnly cookie it cannot read, which is what makes it
 * safe from a script that manages to run on the page.
 *
 * The VS Code extension is the case that cannot work this way, and it uses the
 * bearer token the API's `bearer()` plugin accepts instead.
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { useSession, signOut } = authClient;

/** The providers offered on the sign-in screen, in display order. */
export const PROVIDERS = [
  { id: "google", label: "Continue with Google" },
  { id: "github", label: "Continue with GitHub" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * Starts a provider redirect.
 *
 * `callbackURL` is where the provider returns to after a successful sign-in.
 * It must be listed in the API's trusted origins, or Better Auth refuses the
 * redirect — that check is what stops a crafted callback handing someone
 * else's session to another site.
 */
export async function signInWith(provider: ProviderId): Promise<void> {
  await authClient.signIn.social({
    provider,
    callbackURL: window.location.origin,
  });
}
