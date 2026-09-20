/**
 * The schema handed to Better Auth's Drizzle adapter: the four core auth
 * models plus the three the organization plugin owns, because the adapter
 * treats every key as a possible auth table. Keys must stay singular — see
 * the Better Auth note in `schema.ts`.
 *
 * `todos` and `user_email` are deliberately absent: they are ours, and the
 * adapter has no business with either.
 */

import {
  account,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from "./schema.js";

export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
} as const;
