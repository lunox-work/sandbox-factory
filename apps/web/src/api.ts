/**
 * The app's single client instance.
 *
 * Same-origin in both dev and production — Vite proxies /api to the API in
 * dev — so no base URL needs configuring here.
 *
 * `getToken` stays null on purpose now that Better Auth has landed. The web
 * app authenticates with an httpOnly session cookie, which the browser attaches
 * to these same-origin requests by itself and which JavaScript cannot read — so
 * there is no token to hand back here, and that is the safer arrangement.
 *
 * The seam is not dead: the VS Code extension builds the same client with a
 * real `getToken` that reads the bearer token out of secret storage, because an
 * extension host has no cookie jar.
 */

import { TodoClient } from "@sandbox-factory/client";

export const api = new TodoClient({
  baseUrl: "",
  getToken: () => null,
});
