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

## Where the remaining pieces go

Not yet built, but the boundaries are drawn for them:

- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`
  only.
- **Auth** — the client already takes a `getToken` callback; the web app returns
  the session token and the extension reads VS Code's encrypted secret storage.
  Neither needs restructuring when real auth lands.
