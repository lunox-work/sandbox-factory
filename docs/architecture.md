# Architecture

How the workspaces fit together, and why the boundaries sit where they do.

## Why one repository

The API, the web app, and the extension are three views of one contract. Split
across repositories, adding a field to a todo means: publish `shared`, bump it
in `client`, publish `client`, bump it in two consumers — four pull requests
across three repositories to ship one change, with every intermediate state a
chance for the types to drift apart.

Here it is one pull request, and CI type-checks all three consumers against the
change before it can merge.

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

`packages/db` sits beside `shared` rather than under it: it depends on `core`
for the domain type it round-trips, and on nothing else in the repo. Only
`apps/api` imports it.

| Workspace         | May import       | Must never import           |
| ----------------- | ---------------- | --------------------------- |
| `packages/core`   | nothing          | anything at all             |
| `packages/shared` | `core`, `zod`    | `client`, any app, `node:*` |
| `packages/client` | `core`, `shared` | any app, `node:*`, `vscode` |
| `packages/db`     | `core`           | `client`, any app           |
| `apps/*`          | any package      | another app                 |

Three rules are worth stating plainly, because breaking them is easy and the
consequences arrive weeks later:

**`packages/core` has no dependencies.** Not zod, not anything. It is bundled
into a browser, a Node server, and an extension host, and it is the one package
published to npm for other people to use.

**`packages/client` must stay platform-neutral.** It uses `fetch` and nothing
else — no `node:*`, no `window`, no `vscode`. This is enforced mechanically:
[`packages/client/tsconfig.json`](../packages/client/tsconfig.json) sets
`types: []`, so an accidental `node:crypto` import fails to compile rather than
breaking the extension bundle at runtime. The `lib` there includes `DOM` only for
the web-standard `fetch`/`Headers`/`RequestInit` types, which exist in every
runtime this code targets.

**Only `apps/extension` may import `vscode`.** That module exists only inside the
extension host. Keeping it in one workspace is what lets the other 90% of the
extension's logic live in shared packages.

## The domain rules live in exactly one place

[`packages/core`](../packages/core/src/index.ts) owns what a valid todo is and
what may be done to one. Everything else asks it:

- `apps/api` calls `normalizeTitle()` on write and turns `InvalidTitleError`
  into a 400.
- `apps/web` calls `isValidTitle()` to disable the Add button, and
  `filterTodos()` / `countTodos()` to render the list and its counts.
- `apps/extension` calls `isValidTitle()` to validate its input box.

So the web app cannot submit a title the API would reject, "active" means the
same thing in both surfaces, and changing the title cap is a one-line edit that
propagates everywhere.

`packages/shared` derives its zod schemas from the same constants
(`TITLE_MAX_LENGTH`, `TODO_FILTERS`) rather than restating them, so the wire
validation and the domain rules cannot drift apart.

## TypeScript configuration

[`tooling/tsconfig`](../tooling/tsconfig) holds the strictness contract —
`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and the rest —
in `base.json`. Every workspace extends one of its four variants:

| Config           | For                    | Notable departure                         |
| ---------------- | ---------------------- | ----------------------------------------- |
| `base.json`      | platform-neutral code  | —                                         |
| `node.json`      | API and Node libraries | adds `@types/node`                        |
| `react.json`     | the web app            | `moduleResolution: Bundler`, DOM libs     |
| `extension.json` | the VS Code extension  | **CommonJS** — the host does not load ESM |

Extend these rather than copying compiler options between packages. Path settings
(`rootDir`, `outDir`, `include`) deliberately stay in the extending config: those
are per-package, the strictness is not.

The extension being CommonJS is the single exception to the repo's ESM rule, and
it is not negotiable — the VS Code extension host does not load ES modules.

## Import extensions differ by workspace, on purpose

Workspaces on `NodeNext` (`core`, `shared`, `client`, `db`, `api`) write
`from "./store.js"` even though the file is `store.ts`. Workspaces on `Bundler`
(`web`, `extension`) write `from "./tree"` with no extension. Both are correct
for their resolution mode; a file moved between them needs its imports adjusted.

## The database layer

[`packages/db`](../packages/db) holds the Drizzle schema, the migrations, the
Postgres implementation of `TodoStore`, and an S3 object store.

The store contract and `NotFoundError` live **in this package**, not in
`apps/api`, because dependencies point downward and a package may not import an
app. [`apps/api/src/store.ts`](../apps/api/src/store.ts) re-exports both, so
`routes.ts` and its tests import from `./store.js` exactly as before — swapping
the in-memory store for Postgres did not touch a single route.

`createInMemoryStore` is still there, but it is now a **test double**, not a
fallback. The server requires `DATABASE_URL` and will not boot without it: a
process that silently keeps todos in memory looks healthy and loses them on the
next restart.

Object storage targets SeaweedFS' S3 gateway, but nothing in the code is
SeaweedFS-specific — it speaks S3, so the same client works against AWS S3,
MinIO or R2 by changing the endpoint. Two caveats if you do swap the backend:

- `forcePathStyle` is on, because a self-hosted gateway has no per-bucket DNS.
- SeaweedFS **creates a bucket on first write**. S3 and MinIO do not; they
  return `NoSuchBucket`. Anything deployed against a different backend needs
  its bucket created up front.

Nothing in the API consumes the object store yet. It is wired into config and
compose and tested, so the feature that needs it adds a call, not a layer.

## Auth

Better Auth, configured in `apps/api/src/auth.ts` and mounted at
`/api/auth/*`. Google and GitHub are the only ways in: `emailAndPassword` is
never enabled, so `/api/auth/sign-up/email` answers 400 and no row in `account`
ever carries a password.

The four tables it needs — `user`, `session`, `account`, `verification` — live
in `packages/db/src/schema.ts` alongside `todos`, and are bundled for the
adapter as `authSchema`. Two naming rules there are load-bearing and fail at
runtime rather than at compile time, because the adapter resolves both by
string: the exported consts are **singular**, and the column properties are
**camelCase** even though the columns themselves are snake_case. The comment on
those tables explains it; do not rename either without reading it.

**Account linking is implicit, and the trusted list is what makes that safe.**
Signing in with a provider whose verified email already belongs to an account
merges into it rather than being refused — the ordinary case being one person
with a Google and a GitHub account on the same inbox. The merge happens only
when the provider is in `trustedProviders` _and_ asserts `email_verified`, and
only when the existing account's own address is verified. Adding a provider to
that list is therefore a security decision, not a configuration one: it must
verify address ownership before reporting an email, or whoever controls an
account there reaches the account already using that address.
`apps/api/test/auth.test.ts` pins the list so widening it cannot pass unnoticed.

**Two credentials, one session store.** The web app and the extension
authenticate differently because their platforms differ:

| Surface          | Carries                 | Why                                        |
| ---------------- | ----------------------- | ------------------------------------------ |
| `apps/web`       | httpOnly cookie         | The browser attaches it; JS cannot read it |
| `apps/extension` | `Authorization: Bearer` | An extension host has no cookie jar        |

The `bearer()` plugin is what makes the second work, and the guard in
`routes.ts` hands Better Auth the whole header set rather than picking one, so
neither path is special-cased. `packages/client` sends `credentials: "include"`
so the cookie survives the cross-subdomain hop from app.lunox.work to
api.lunox.work, where fetch's own default would drop it.

**One provider identity, one user.** `account` carries a unique constraint on
`(provider_id, account_id)`. Better Auth already refuses to link an account
another user holds — on sign-in, on the OAuth redirect and through the link API,
all of which look the identity up globally rather than per user. The constraint
is there because the library assumes that invariant rather than tolerating a
breach: `findAccountByKey` throws "Multiple accounts match the same accountId"
when two rows collide, which breaks sign-in for both users at once. The database
now refuses the write instead of discovering it later.

Everything under `/api/v1` requires a session; `/health` and `/api/auth/*` do
not — signing in cannot require already being signed in. If `createApp` is
given no `auth`, it serves 503 on `/api/*` rather than serving todos
unauthenticated, so a deploy that forgets the auth environment fails closed.

A session answers _who is asking_, which is not the same as _what they may
read_. `todos.user_id` is what makes the answer differ per asker: every method
on `TodoStore` takes the owner as its first argument and puts it in the query,
so there is no call that can read or write across users. That shape is
deliberate — a store method that merely _accepted_ a filter could be called
without one, and for a period this API was exactly that, sitting behind a
session while serving every user the whole table. An id belonging to someone
else returns 404 rather than 403, matching the email routes: a 403 confirms the
id exists and lets it be enumerated.

## Where the remaining pieces go

Not yet built, but the boundaries are drawn for them:

- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`
  only.
- **The extension's sign-in** — the client's `getToken` callback is the seam,
  reading VS Code's encrypted secret storage. The API already accepts the
  bearer token it would return.
