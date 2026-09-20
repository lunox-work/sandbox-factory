# Architecture

## Dependency direction

Dependencies point downward only. Nothing below imports from above.

```
apps/api        apps/web        apps/extension
     │    │          │                │
     │    │          └────────┬───────┘
     │    │                   │
     │    │         packages/client
     │    │                   │
     │    └───────┬───────────┘
     │            │
     │    packages/shared
     │            │
     │            │
  packages/db ────┴──── packages/core
```

| Workspace         | May import       | Must never import           |
| ----------------- | ---------------- | --------------------------- |
| `packages/core`   | nothing          | anything at all             |
| `packages/shared` | `core`, `zod`    | `client`, any app, `node:*` |
| `packages/client` | `core`, `shared` | any app, `node:*`, `vscode` |
| `packages/db`     | `core`           | `client`, any app           |
| `apps/*`          | any package      | another app                 |

Three of these are enforced or load-bearing:

- **`packages/core` has zero dependencies.** It is bundled into a browser, a
  Node server, and an extension host, and is the one publishable package.
- **`packages/client` stays platform-neutral.** `fetch` only.
  [`packages/client/tsconfig.json`](../packages/client/tsconfig.json) sets
  `types: []`, so a `node:*` import fails to compile rather than breaking the
  extension bundle at runtime. `lib` includes `DOM` only for the web-standard
  `fetch`/`Headers`/`RequestInit` types.
- **Only `apps/extension` may import `vscode`.** That module exists only in the
  extension host; confining it is what lets the rest of the extension's logic
  live in shared packages.

`packages/db` sits beside `shared`: it depends on `core` and nothing else in the
repo. Only `apps/api` imports it.

## Domain rules live in `packages/core`

[`packages/core`](../packages/core/src/index.ts) owns what a valid todo is.
Everything else asks it: `apps/api` calls `normalizeTitle()` on write and maps
`InvalidTitleError` to a 400; `apps/web` calls `isValidTitle()`,
`filterTodos()`, and `countTodos()`; `apps/extension` calls `isValidTitle()`.

`packages/shared` derives its zod schemas from core's constants
(`TITLE_MAX_LENGTH`, `TODO_FILTERS`) rather than restating them.

## TypeScript configuration

[`tooling/tsconfig`](../tooling/tsconfig) holds the strictness contract in
`base.json`. Every workspace extends one of four variants:

| Config           | For                    | Notable departure                         |
| ---------------- | ---------------------- | ----------------------------------------- |
| `base.json`      | platform-neutral code  | —                                         |
| `node.json`      | API and Node libraries | adds `@types/node`                        |
| `react.json`     | the web app            | `moduleResolution: Bundler`, DOM libs     |
| `extension.json` | the VS Code extension  | **CommonJS** — the host does not load ESM |

Extend these rather than copying compiler options. Path settings (`rootDir`,
`outDir`, `include`) stay in the extending config.

Import extensions follow the resolution mode. `NodeNext` (`core`, `shared`,
`client`, `db`, `api`) writes `from "./store.js"` for `store.ts`; `Bundler`
(`web`, `extension`) writes `from "./tree"`. A file moved between them needs its
imports adjusted.

## The database layer

[`packages/db`](../packages/db) holds the Drizzle schema, migrations, the
Postgres `TodoStore`, and an S3 object store.

The store contract and `NotFoundError` live in this package, not in `apps/api`,
because a package may not import an app.
[`apps/api/src/store.ts`](../apps/api/src/store.ts) re-exports both.

`createInMemoryStore` is a **test double**, not a fallback. The server requires
`DATABASE_URL` and will not boot without it.

Object storage targets SeaweedFS' S3 gateway but is not SeaweedFS-specific. Two
caveats if you swap the backend:

- `forcePathStyle` is on, because a self-hosted gateway has no per-bucket DNS.
- SeaweedFS creates a bucket on first write; S3 and MinIO return `NoSuchBucket`.
  Other backends need the bucket created up front.

Nothing in the API consumes the object store yet.

## Auth

Better Auth, configured in `apps/api/src/auth.ts` and mounted at `/api/auth/*`.
Google, GitHub and Atlassian only — `emailAndPassword` is never enabled, so
`/api/auth/sign-up/email` answers 400.

Its four core tables (`user`, `session`, `account`, `verification`) live in
`packages/db/src/schema.ts`, bundled as `authSchema` together with the
organization plugin's three (see [Organizations](#organizations)). **Two naming rules fail at
runtime rather than compile time**, because the adapter resolves both by string:
the exported consts are singular, and the column properties are camelCase even
though the columns are snake_case.

**Account linking is implicit, and `trustedProviders` is what makes that safe.**
Signing in with a provider whose verified email already belongs to an account
merges into it — only when the provider is trusted _and_ asserts
`email_verified`, and the existing account's address is verified. Adding a
provider to that list is a security decision: it must verify address ownership
before reporting an email. `apps/api/test/auth.test.ts` pins the list.

**Atlassian is trusted by assertion.** It reports no `email_verified` claim, so
`auth.ts` asserts one via `mapProfileToUser` and adds it to `trustedProviders`.
Untrusted is not a usable position — the same guard gates the authenticated
link route, so an untrusted Atlassian could not be connected from the account
page either. The accepted risk: whoever controls an Atlassian account bearing an
address can reach the account using it.

Atlassian also needs an explicit `read:me` scope — its default scopes return a
profile with no email — and sets `disableDefaultScope` to drop the site-scoped
`read:jira-user`. Requesting no product scopes lets the Atlassian app be
registered as resource-level (one selected site) rather than account-level.

**Two credentials, one session store:**

| Surface          | Carries                 | Why                                        |
| ---------------- | ----------------------- | ------------------------------------------ |
| `apps/web`       | httpOnly cookie         | The browser attaches it; JS cannot read it |
| `apps/extension` | `Authorization: Bearer` | An extension host has no cookie jar        |

The `bearer()` plugin enables the second, and the guard in `routes.ts` hands
Better Auth the whole header set rather than picking one. `packages/client`
sends `credentials: "include"` so the cookie survives a cross-subdomain hop.

`account` carries a unique constraint on `(provider_id, account_id)`. Better
Auth assumes that invariant rather than tolerating a breach —
`findAccountByKey` throws when two rows collide, breaking sign-in for both
users.

Everything under `/api/v1` requires a session; `/health` and `/api/auth/*` do
not. If `createApp` is given no `auth`, it serves 503 on `/api/*`, so a deploy
missing the auth environment fails closed.

**A session answers who is asking, not what they may read.** Every `TodoStore`
method takes the owner as its first argument and puts it in the query — `create`
records it, `update` and `remove` match on both id and owner — so no call can
read _or write_ across users. An id belonging to someone else returns 404, not
403, so ids cannot be enumerated.

## Organizations

The second principal. Better Auth's `organization` plugin owns the tables
(`organization`, `member`, `invitation`) and every write to them, served under
`/api/auth/organization/*`. `packages/db/src/organizations.ts` covers the reads
it does not offer, and `apps/api/src/routes.ts` mounts them under
`/api/v1/orgs`.

**Two names, as a user has.** `organization.id` is permanent and is what
anything durable references; `organization.slug` is the public handle, unique
but renameable. The pair mirrors `user.id` and `user.username` deliberately, so
neither principal invites the mistake of storing a name as a key.

**The handle rules live in `packages/core`.** `packages/core/src/handle.ts` is
the single definition, shared by the profile store, the plugin hooks, the wire
schemas and both browser forms — the only package all four can import. Users
and organizations have **separate** handle namespaces: `dana` can be both.
Sharing one would need cross-table uniqueness, which the email work showed
costs a trigger pair plus an advisory lock (migrations 0007 to 0011), and
nothing needs a bare `/{handle}` URL. Prefixed paths (`/u/`, `/o/`) keep them
apart.

**The plugin leaves two gaps, closed by hooks in `auth.ts`.** It accepts any
non-empty string as a slug, so `beforeCreateOrganization` and
`beforeUpdateOrganization` validate and lowercase it. And its own "already
taken" check runs on the **raw** body before those hooks normalise it, so
`MyOrg` while `myorg` exists would pass it and fail on the unique constraint as
a 500; the hooks repeat the check case-insensitively, excluding the
organization's own id so a re-cased rename is not a collision.

**`session.activeOrganizationId` is a preference, never an authorisation
input.** One value is shared by every tab and by the extension's bearer
session, and the five-minute session cookie cache means a change in one lags in
another. Organization-scoped routes take the id from the path and check
membership against the `member` table; a non-member gets 404, not 403, exactly
as another user's todo does.

**Invitations are in-app.** `sendInvitationEmail` is left unset because this
codebase sends no mail: an invitation is a row the invitee finds on their
account page. It is addressed to their **primary** address, since that is what
Better Auth compares against the session on accept. The server-only `addMember`
endpoint is not used — joining changes what a session can reach, so the person
accepts it.

**Every organization keeps at least one owner.** The plugin refuses to let the
last one leave, be removed or be demoted; the settings page disables those
controls rather than letting the click fail.

**There is no organization switcher.** Nothing the app renders is owned by an
organization yet — todos are personal — so a control that changed the "active"
one moved a tick and nothing else, which reads as broken. The avatar menu has
one **Organizations** item opening a list page; a row leads to that
organization's settings. `useOrganizations` keeps `select` and `clear`, both
tested, for the change that first renders organization-owned data.
`session.activeOrganizationId` is written by those and by nothing else.

### Open questions

Neither blocks anything; both are cheap if a need appears.

- **Invitations match the primary address only.** One sent to an address
  someone has proven but not made primary stays invisible to them. The fix is
  a `beforeAcceptInvitation` hook accepting any of the caller's proven
  addresses (`EmailStore.list`), not a schema change.
- **Handles are not reserved.** Words like `admin`, `api`, `o` and `u` can be
  claimed by a user or an organization. Once prefixed URLs (`/u/`, `/o/`)
  carry real pages, add a short reserved list to
  `packages/core/src/handle.ts`, applied to both principals.

### Deliberately not built

Teams; per-organization custom roles (`dynamicAccessControl`); an email
transport, at which point `sendInvitationEmail` is one function and the in-app
flow stays as the fallback; organization avatars in object storage (`logo`
holds a URL for now); moving `todos` to organization ownership; a shared handle
namespace via a registry table, if a bare `/{handle}` URL is ever wanted.

## Not yet built

- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`.
- **The extension's sign-in** — the client's `getToken` callback is the seam,
  reading VS Code's encrypted secret storage. The API already accepts the token.
