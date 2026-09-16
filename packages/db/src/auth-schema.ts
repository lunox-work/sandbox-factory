/**
 * The schema object handed to Better Auth's Drizzle adapter.
 *
 * This exists as its own export, rather than letting the adapter read the whole
 * schema module, because the adapter resolves a model by looking up
 * `schema[modelName]` — so every key in the object it receives is a name it may
 * try to treat as an auth table. Passing the full module would put `todos` in
 * that namespace for no reason. Bundling exactly the four auth models keeps the
 * adapter's view of the database to the tables it owns.
 *
 * The keys are Better Auth's model names and must stay singular; see the note
 * on the table definitions in `schema.js` for why.
 */

import { account, session, user, verification } from "./schema.js";

export const authSchema = { user, session, account, verification } as const;
