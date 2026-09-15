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
     │               │                │
     │               └────────┬───────┘
     │                        │
     │              packages/client
     │                        │
     └────────────┬───────────┘
                  │
          packages/shared
                  │
           packages/core
```

| Workspace         | May import       | Must never import           |
| ----------------- | ---------------- | --------------------------- |
| `packages/core`   | nothing          | anything at all             |
| `packages/shared` | `core`, `zod`    | `client`, any app, `node:*` |
| `packages/client` | `core`, `shared` | any app, `node:*`, `vscode` |
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

Workspaces on `NodeNext` (`core`, `shared`, `client`, `api`) write
`from "./store.js"` even though the file is `store.ts`. Workspaces on `Bundler`
(`web`, `extension`) write `from "./tree"` with no extension. Both are correct
for their resolution mode; a file moved between them needs its imports adjusted.

## Where the remaining pieces go

Not yet built, but the boundaries are drawn for them:

- **`packages/db`** — Drizzle schema and migrations. `apps/api` swaps its
  in-memory store for this; [`store.ts`](../apps/api/src/store.ts) already
  defines the `TodoStore` interface the real one will satisfy, so routes do not
  change.
- **`packages/integrations`** — GitHub and Jira clients, depending on `shared`
  only.
- **Auth** — the client already takes a `getToken` callback; the web app returns
  the session token and the extension reads VS Code's encrypted secret storage.
  Neither needs restructuring when real auth lands.
