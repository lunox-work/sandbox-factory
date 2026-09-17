/**
 * The app's single client instance. Same-origin, so no base URL; see `auth.ts`.
 *
 * `getToken` returns null on purpose: the web app authenticates with an
 * httpOnly session cookie, so there is no token to hand back. The seam is live
 * elsewhere — the VS Code extension passes a real `getToken`.
 */

import { TodoClient } from "@sandbox-factory/client";

export const api = new TodoClient({
  baseUrl: "",
  getToken: () => null,
});
