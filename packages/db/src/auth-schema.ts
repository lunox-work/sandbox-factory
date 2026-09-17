/**
 * The schema handed to Better Auth's Drizzle adapter: exactly the four auth
 * models, because the adapter treats every key as a possible auth table. Keys
 * must stay singular — see the Better Auth note in `schema.ts`.
 */

import { account, session, user, verification } from "./schema.js";

export const authSchema = { user, session, account, verification } as const;
