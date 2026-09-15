# sandbox-factory

> A todo list — from the web or from VS Code.

[![CI](https://github.com/lunox-work/sandbox-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/lunox-work/sandbox-factory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A monorepo holding the API, the web app, the VS Code extension, and the packages
they share. The domain rules live in one package and every surface imports them,
so the browser, the editor, and the server cannot disagree about what a valid
todo is.

## What's in here

| Workspace                                | What it is                                        |
| ---------------------------------------- | ------------------------------------------------- |
| [`packages/core`](./packages/core)       | Todo rules and helpers. The published npm package |
| [`packages/shared`](./packages/shared)   | Zod schemas for the wire format                   |
| [`packages/client`](./packages/client)   | Typed API client, used by web **and** extension   |
| [`apps/api`](./apps/api)                 | Hono HTTP API                                     |
| [`apps/web`](./apps/web)                 | Vite + React dashboard                            |
| [`apps/extension`](./apps/extension)     | VS Code extension                                 |
| [`tooling/tsconfig`](./tooling/tsconfig) | The shared TypeScript strictness contract         |

See [docs/architecture.md](./docs/architecture.md) for how they depend on each
other and why the boundaries sit where they do.

## Quickstart

Requires Node.js 22 or newer.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
npm ci
npm run build
```

Then start the API and the web app together:

```bash
npm run dev
```

Open <http://localhost:5173>. Add a todo, check it off, click its title to
rename it, or delete it with the ×. The web app proxies `/api` to the API on
port 4000, so both run same-origin in development — the same shape as production.

The API ships with an in-memory store seeded with one todo, so there is no
database to set up and no `.env` to write before it works. Todos reset when the
API restarts.

To run just one of them:

```bash
npm run dev --workspace @sandbox-factory/api   # http://localhost:4000
npm run dev --workspace @sandbox-factory/web   # http://localhost:5173
```

Both watch and reload on change. Configuration is optional and per-app — see
[`apps/api/.env.example`](./apps/api/.env.example) and
[`apps/web/.env.example`](./apps/web/.env.example).

### The VS Code extension

```bash
npm run dev --workspace sandbox-factory-vscode
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.
Point it at a different API with the `sandboxFactory.apiBaseUrl` setting.

## Using the published package

`packages/core` is published to npm as `sandbox-factory`. It is dependency-free
and safe to use in a browser, in Node, or inside an editor extension.

```bash
npm install sandbox-factory
```

```ts
import { nextStatuses, transition } from "sandbox-factory";

nextStatuses("pending"); // ["provisioning", "failed"]
transition(
  { id: "sbx_1", name: "demo", status: "pending", createdAt: "…" },
  "provisioning",
);
```

## Development

| Command          | What it does                                  |
| ---------------- | --------------------------------------------- |
| `npm run verify` | Everything CI runs — the gate before pushing  |
| `npm run build`  | Build every workspace, in dependency order    |
| `npm test`       | Test every workspace with coverage thresholds |
| `npm run lint`   | Type-check every workspace                    |
| `npm run format` | Apply formatting                              |

Scope to one workspace and its dependencies with turbo's filter:

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev
setup, conventions, and how to open a pull request. By participating you agree
to the [Code of Conduct](./CODE_OF_CONDUCT.md).

Coding agents should read [AGENTS.md](./AGENTS.md), which covers the same ground
plus the conventions that the automation depends on.

## Documentation

| Document                                       | Covers                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| [AGENTS.md](./AGENTS.md)                       | Instructions for coding agents                      |
| [docs/architecture.md](./docs/architecture.md) | Workspace layout and dependency rules               |
| [CONTRIBUTING.md](./CONTRIBUTING.md)           | Dev setup and pull request process                  |
| [docs/ci.md](./docs/ci.md)                     | Workflows, branch protection, releases              |
| [docs/github-apps.md](./docs/github-apps.md)   | Installed apps and settings that live outside files |

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).
Do not open a public issue for security problems.

## License

[MIT](./LICENSE) © feversoul
