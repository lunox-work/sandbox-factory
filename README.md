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

## Run it

Needs **Docker** and **Make**. Nothing else — not even Node.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
cp .env.example .env    # then fill in the auth section, see below
make up
```

Open <http://localhost:5173>. Sign in with Google or GitHub, then add a todo,
check it off, click its title to rename it, delete it with the ×.

### The one bit of setup: OAuth credentials

Sign-in is Google and GitHub only — there is no email and password option — so
the API needs a client from at least one of them before it will boot. Fill in
the auth section of `.env`:

```bash
# A signing secret for session tokens — any 32+ characters.
openssl rand -base64 32
```

Then register an OAuth client and paste in its id and secret:

| Provider | Where                                                                                                             | Redirect URI to register                         |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Google   | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → OAuth client ID → Web application | `http://localhost:4000/api/auth/callback/google` |
| GitHub   | [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App                          | `http://localhost:4000/api/auth/callback/github` |

The redirect URI has to match exactly — a trailing slash or the wrong port is
rejected by the provider, not by this app, so the error appears on their page
rather than in your logs.

If you only want to look around, `npm run verify` runs the whole test suite and
needs none of this.

The first `make up` installs dependencies inside the containers, so give it a
minute. After that it starts in seconds. `make down` stops it.

### Plus the VS Code extension

```bash
make ext
```

Then open this repo in VS Code and press <kbd>F5</kbd>. A second window opens
with the extension loaded — the sandbox-factory icon is in its activity bar.

The extension runs on your machine, not in Docker: it is a bundle the editor
loads, so there is no process for a container to run. `make ext` needs Node 22+
and installs what it needs on first run.

Both surfaces talk to the same API, so a todo added in one shows in the other.

## Develop it

Needs **Node.js 22+**. Docker optional.

```bash
make dev
```

Runs the API and web app directly on your machine — faster reload than the
containers, and debuggers attach without ceremony. This is what you want day to
day.

| Command       | What it does                                  |
| ------------- | --------------------------------------------- |
| `make dev`    | API on :4000, web on :5173, hot reload        |
| `make ext`    | Rebuild the extension on save                 |
| `make verify` | Everything CI runs — the gate before pushing  |
| `make test`   | Test every workspace with coverage thresholds |
| `make build`  | Build every workspace, in dependency order    |
| `make lint`   | Type-check every workspace                    |
| `make format` | Apply formatting                              |

Run `make` on its own for the full list. Every target delegates to an npm
script, so `make test` and `npm test` cannot drift apart — use whichever you
prefer.

Scope a check to one workspace and its dependencies:

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

### Running it in containers instead

```bash
make up        # dev containers — source mounted, hot reload intact
make up-prod   # built images behind nginx on :8080, what deployment looks like
```

`make up-prod` serves everything through nginx on one origin with `/api`
proxied, matching the dev server's proxy so cookie and CORS behaviour does not
differ between the two.

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `make up` / `down`  | Dev containers                                     |
| `make up-prod`      | Built images behind nginx                          |
| `make build-images` | Build the production images without starting them  |
| `make logs` / `ps`  | Follow logs, show status                           |
| `make reset`        | Stop everything and **delete** the database volume |

Ports are overridable: `API_PORT`, `WEB_PORT`, `WEB_PROD_PORT`, `POSTGRES_PORT`.

### The extension's edit loop

`make ext` rebuilds the bundle on save, and the Extension Development Host
reloads itself when it changes — [`.vscode/settings.json`](./.vscode/settings.json)
turns on `debug.extensionHost.autoReload`. That reloads the whole extension
host rather than hot-swapping a module, so in-memory state is lost and the tree
refetches; it is as close to hot reload as the extension host gets.

`make ext-package` produces a `.vsix` if you want to install it properly.

### Postgres and object storage

`make db-up` starts Postgres and SeaweedFS and waits for both; they also start
with either container profile.

The API **requires** Postgres — it has no in-memory fallback, so it will not
boot without `DATABASE_URL`, nor without the auth variables above. After
starting the services, apply the schema:

```bash
make migrate
```

| Command       | What it does                                 |
| ------------- | -------------------------------------------- |
| `make psql`   | Open a psql shell against the local database |
| `make db-url` | Print the `DATABASE_URL`                     |
| `make s3-url` | Print the S3 endpoint                        |
| `make reset`  | Stop everything and delete both data volumes |

SeaweedFS provides an S3-compatible gateway on port 8333; its filer browser is
on 8888 if you want to confirm an upload landed. Credentials in
`docker-compose.yml` are development values only.

The test suite does **not** need either service: `npm run verify` passes with
Docker stopped.

## Using the published package

`packages/core` is published to npm as `sandbox-factory`. It is dependency-free
and safe to use in a browser, in Node, or inside an editor extension.

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
