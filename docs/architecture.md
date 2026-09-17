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

Its four tables (`user`, `session`, `account`, `verification`) live in
`packages/db/src/schema.ts`, bundled as `authSchema`. **Two naming rules fail at
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

## Not yet built

- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`.
- **The extension's sign-in** — the client's `getToken` callback is the seam,
  reading VS Code's encrypted secret storage. The API already accepts the token.
