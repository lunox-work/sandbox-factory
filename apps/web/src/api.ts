/**
 * The app's single client instance.
 *
 * Same-origin in both dev and production — Vite proxies /api to the API in
 * dev — so no base URL needs configuring here.
 *
 * `getToken` is the seam for auth: it returns null today, and becomes a read
 * from the session once Better Auth lands. Nothing else in the app changes.
 */

import { TodoClient } from "@sandbox-factory/client";

export const api = new TodoClient({
  baseUrl: "",
  getToken: () => null,
});
