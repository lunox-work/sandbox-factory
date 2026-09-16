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

See [docs/architecture.md](./docs/architecture.md) for the dependency rules.

## Run it

Needs **Docker** and **Make**. Nothing else — not even Node.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
cp .env.example .env    # then fill in the auth section, see below
make up
```

Open <http://localhost:5173>. The first `make up` installs dependencies inside
the containers, so give it a minute; after that it starts in seconds. `make down`
stops it.

### The one bit of setup: OAuth credentials

Sign-in is Google and GitHub only, so the API needs a client from at least one of
them before it will boot. Fill in the auth section of `.env`, starting with a
signing secret of 32+ characters:

```bash
openssl rand -base64 32
```

Then register an OAuth client and paste in its id and secret:

| Provider | Where                                                                                                             | Redirect URI to register                         |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Google   | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → OAuth client ID → Web application | `http://localhost:4000/api/auth/callback/google` |
| GitHub   | [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App                          | `http://localhost:4000/api/auth/callback/github` |

The redirect URI has to match exactly — a trailing slash or the wrong port is
rejected by the provider, so the error appears on their page rather than in your
logs.

If you only want to look around, `npm run verify` runs the whole test suite and
needs none of this.

### Plus the VS Code extension

```bash
make ext
```

Then open this repo in VS Code and press <kbd>F5</kbd>. A second window opens
with the extension loaded — the sandbox-factory icon is in its activity bar.

It runs on your machine, not in Docker: it is a bundle the editor loads, so
`make ext` needs Node 22+. Both surfaces share one API, so a todo added in one
shows in the other.

## Develop it

Needs **Node.js 22+**. Docker optional.

```bash
make dev
```

Runs the API and web app directly on your machine — faster than the containers,
and what you want day to day.

| Command       | What it does                                  |
| ------------- | --------------------------------------------- |
| `make dev`    | API on :4000, web on :5173, hot reload        |
| `make ext`    | Rebuild the extension on save                 |
| `make verify` | Everything CI runs — the gate before pushing  |
| `make test`   | Test every workspace with coverage thresholds |
| `make build`  | Build every workspace, in dependency order    |
| `make lint`   | Type-check every workspace                    |
| `make format` | Apply formatting                              |

Run `make` on its own for the full list. Every target delegates to an npm script,
so `make test` and `npm test` cannot drift apart.

Scope a check to one workspace:

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

### Running it in containers instead

```bash
make up        # dev containers — source mounted, hot reload intact
make up-prod   # built images behind nginx on :8080, what deployment looks like
```

`make up-prod` serves through nginx on one origin with `/api` proxied, matching
the dev server so cookie and CORS behaviour does not differ between the two.

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `make up` / `down`  | Dev containers                                     |
| `make up-prod`      | Built images behind nginx                          |
| `make build-images` | Build the production images without starting them  |
| `make logs` / `ps`  | Follow logs, show status                           |
| `make reset`        | Stop everything and **delete** the database volume |

Ports are overridable: `API_PORT`, `WEB_PORT`, `WEB_PROD_PORT`, `POSTGRES_PORT`.

### The extension's edit loop

`make ext` rebuilds the bundle on save, and
[`.vscode/settings.json`](./.vscode/settings.json) sets
`debug.extensionHost.autoReload` so the Development Host picks it up. The whole
host reloads, so in-memory state is lost and the tree refetches.

`make ext-package` produces a `.vsix`.

### Postgres and object storage

`make db-up` starts Postgres and SeaweedFS and waits for both; they also start
with either container profile. The API **requires** Postgres and will not boot
without `DATABASE_URL` or the auth variables above. Then apply the schema:

```bash
make migrate
```

| Command       | What it does                                 |
| ------------- | -------------------------------------------- |
| `make psql`   | Open a psql shell against the local database |
| `make db-url` | Print the `DATABASE_URL`                     |
| `make s3-url` | Print the S3 endpoint                        |
| `make reset`  | Stop everything and delete both data volumes |

SeaweedFS' S3-compatible gateway is on port 8333, its filer browser on 8888.
Credentials in `docker-compose.yml` are development values only.

The test suite needs neither service: `npm run verify` passes with Docker
stopped.

## Using the published package

`packages/core` is published to npm as `sandbox-factory`. It is dependency-free
and runs in a browser, in Node, or inside an editor extension.

```bash
npm install sandbox-factory
```

```ts
import {
  countTodos,
  filterTodos,
  normalizeTitle,
  toggle,
} from "sandbox-factory";

normalizeTitle("  buy milk  "); // "buy milk"
toggle(todo); // a new todo with `done` flipped
filterTodos(todos, "active");
countTodos(todos); // { total, active, completed }
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, conventions, and how to
open a pull request. By participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md). Coding agents should read
[AGENTS.md](./AGENTS.md).

## Documentation

| Document                                       | Covers                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| [AGENTS.md](./AGENTS.md)                       | Instructions for coding agents                      |
| [docs/architecture.md](./docs/architecture.md) | Workspace layout and dependency rules               |
| [CONTRIBUTING.md](./CONTRIBUTING.md)           | Dev setup and pull request process                  |
| [docs/ci.md](./docs/ci.md)                     | Workflows, branch protection, releases              |
| [docs/github-apps.md](./docs/github-apps.md)   | Installed apps and settings that live outside files |

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md). Do
not open a public issue for security problems.

## License

[MIT](./LICENSE) © feversoul
