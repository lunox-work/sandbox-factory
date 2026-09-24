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

[`packages/core`](../packages/core/src/index.ts) owns what a valid public
handle is. Everything else asks it: `apps/api` calls `normalizeHandle()` before
storing one and maps the refusal to a 400; `apps/web` calls `isValidHandle()`
and `toHandleStem()` in the rename forms.

It is a genuine domain rule rather than a wire concern, because users and
organizations draw handles from **one namespace** — a personal organization
takes its owner's handle — so what counts as valid has to be decided once.

`packages/shared` refines core's rules in `handleSchema` rather than restating
them, so a change to the rules cannot leave the two disagreeing.

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
owner-scoped stores, and an S3 object store.

The store contracts and `NotFoundError` live in this package, not in
`apps/api`, because a package may not import an app.
[`apps/api/src/store.ts`](../apps/api/src/store.ts) re-exports both.

`createInMemoryStore` is a **test double**, not a fallback. The server requires
`DATABASE_URL` and will not boot without it.

Object storage is SeaweedFS' S3 gateway locally and an S3 bucket in
production, through one code path: only the plain object calls are used, and
both answer those the same way. `S3_BUCKET` switches it on; locally the
endpoint and a key pair point at SeaweedFS, in production neither is set, so
the SDK talks to AWS with the task role. The differences that do exist, and
where each is handled:

- `forcePathStyle` is on, because a self-hosted gateway has no per-bucket DNS.
  AWS accepts it too.
- SeaweedFS creates a bucket on first write; S3 returns `NoSuchBucket`.
  Terraform creates the production bucket (`infra/s3.tf`).
- S3 answers a missing key with 403 rather than 404 unless the caller may
  `s3:ListBucket`. The task role has it (`infra/iam.tf`); without it every
  never-uploaded avatar would be a 500.
- SeaweedFS as run in compose does not check credentials at all. Local
  development proves nothing about IAM; the production grant is its own check.

## Avatars

Every user and team has a generated identicon
(`packages/shared/src/identicon.ts`, frozen) and may upload a picture over it.
A personal organization has no picture of its own: it wears its owner's face
everywhere, so the only way to change it is on the account page.

**Uploads are re-encoded, never stored as sent.** `apps/api/src/avatars/image.ts`
sniffs the first bytes (PNG, JPEG, WebP or GIF only, so libvips never parses
SVG or anything else), refuses a canvas over 40 megapixels from its header, and
writes a 256px square WebP with no metadata. The object is named by the SHA-256
of those bytes.

**The picture columns hold our own served paths**, e.g.
`/api/avatars/user/<id>/<hash>.webp`, in `user.image` and `organization.logo`.
Both columns used to accept any string from a client — Better Auth's
`update-user` and the organization plugin's create and update — which is why
`logo` was once never rendered. Three hooks in `apps/api/src/auth.ts` now admit
only null or the owner's own avatar path, so both are safe to render. The
`update-user` guard is a _database_ hook on purpose: a request hook runs before
the bearer plugin resolves a session, sees none, and cannot tell the caller's
own path from another account's. A provider picture from signup stays until
the person replaces or removes it.

**Reads are sessionless and immutable.** `GET /api/avatars/:kind/:id/:hash.webp`
sits under `/api/` so every proxy forwards it, outside `/api/v1` so no session
is needed — member lists show other people's pictures, and the hash makes the
URL unguessable without the picture. It is cached for a year, at the browser
and at CloudFront, because a new picture is a new URL.

**Writes go where the session is.** The user upload writes through
`auth.api.updateUser`, whose response re-issues the session cookie, so the
five-minute cookie cache carries the new picture at once. A team's is written
through `OrganizationStore.setLogo` behind the membership guard, for owners
and admins. The replaced object is then deleted, best effort: a failure leaves
an orphan of a few kilobytes rather than failing a change that happened.

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

**A session answers who is asking, not what they may read.** Every store method
takes the owner as its first argument and puts it in the query — `upsert`
records it, `remove` matches on both id and owner — so no call can read _or
write_ across owners. An id belonging to someone else returns 404, not 403, so
ids cannot be enumerated.

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
as any other owner-scoped row does.

**Invitations are in-app.** `sendInvitationEmail` is left unset because this
codebase sends no mail: an invitation is a row the invitee finds on their
account page. It is addressed to their **primary** address, since that is what
Better Auth compares against the session on accept. The server-only `addMember`
endpoint is not used — joining changes what a session can reach, so the person
accepts it.

**Every organization keeps at least one owner.** The plugin refuses to let the
last one leave, be removed or be demoted; the settings page disables those
controls rather than letting the click fail.

**Every user has a personal organization.** It is created by the
`user.create.after` hook in `apps/api/src/auth.ts` — `kind = 'personal'`, a
sole `owner` member, and the user's own handle — and migration `0015` did the
same for everyone who predates the hook. This is what lets anything ownable
take a single non-null `organization_id` rather than a nullable
user/organization pair, which would need a `num_nonnulls(...) = 1` check
drizzle-kit cannot generate and would double every unique index and store path.

It cannot gain members or be deleted: the `refusePersonal` guards in `auth.ts`
cover the invitation, add-member and delete hooks, so "personal" stays a claim
about the organization rather than a label on a two-person one. It goes when
the user does, by the cascade on `personal_user_id`. Sharing means moving the
work to a team organization.

**Nothing below the API boundary branches on `kind`.** The stores take an
organization id and the guard checks membership, whichever kind it is. Only
surfaces distinguish them: the home screen groups connections by owner with
the personal one first, the organizations list labels and sorts it first, and
its settings page hides members, invitations and leaving.

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
flow stays as the fallback; a crop tool, a sweeper for avatar objects orphaned
by a failed delete, and more than one avatar size (see [Avatars](#avatars));
a shared handle namespace via a registry table, if a bare `/{handle}` URL is
ever wanted.

## Not yet built

- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`.
- **The extension's sign-in** — the client's `getToken` callback is the seam,
  reading VS Code's encrypted secret storage. The API already accepts the token.
