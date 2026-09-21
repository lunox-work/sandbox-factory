# sandbox-factory

> Connect a client's Jira site, price its backlog, and get the work done.

[![CI](https://github.com/lunox-work/sandbox-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/lunox-work/sandbox-factory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A monorepo holding the API, the web app, the VS Code extension, and the packages
they share. The domain rules live in one package and every surface imports them,
so the browser, the editor, and the server cannot disagree about what a valid
handle is.

| Workspace                                | What it is                                        |
| ---------------------------------------- | ------------------------------------------------- |
| [`packages/core`](./packages/core)       | Shared domain rules. The publishable package      |
| [`packages/shared`](./packages/shared)   | Zod schemas for the wire format                   |
| [`packages/client`](./packages/client)   | Typed API client, used by web **and** extension   |
| [`packages/jira`](./packages/jira)       | Atlassian OAuth and the Jira REST client          |
| [`packages/db`](./packages/db)           | Drizzle schema, migrations, Postgres and S3 store |
| [`apps/api`](./apps/api)                 | Hono HTTP API                                     |
| [`apps/web`](./apps/web)                 | Vite + React dashboard                            |
| [`apps/extension`](./apps/extension)     | VS Code extension                                 |
| [`tooling/tsconfig`](./tooling/tsconfig) | The shared TypeScript strictness contract         |

## Run it

Needs **Docker** and **Make**. Nothing else — not even Node.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
cp .env.example .env.development    # then fill in the auth section, see below
make up
```

Open <http://localhost:5173>. The first `make up` installs dependencies inside
the containers, so give it a minute. `make down` stops it.

### OAuth credentials

Sign-in is Google, GitHub and Atlassian only, and the API will not boot until
all three are configured. In `.env.development`, set a signing secret
(`openssl rand -base64 32`), then register a client with each provider and
paste in its id and secret:

| Provider  | Where                                                                                                             | Redirect URI                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Google    | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → OAuth client ID → Web application | `http://localhost:4000/api/auth/callback/google`    |
| GitHub    | [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App                          | `http://localhost:4000/api/auth/callback/github`    |
| Atlassian | [developer.atlassian.com](https://developer.atlassian.com/console/myapps/) → OAuth 2.0 integration                | `http://localhost:4000/api/auth/callback/atlassian` |

The redirect URI must match exactly. A mismatch is rejected on the provider's
page, not in your logs. Atlassian needs a little more setup — see the notes in
[`.env.example`](./.env.example).

Just looking around? `npm run verify` runs the whole test suite and needs none
of this.

### The VS Code extension

```bash
make ext
```

Then open this repo in VS Code and press <kbd>F5</kbd>. A second window opens
with the extension loaded — the sandbox-factory icon is in its activity bar.

The extension is a bundle the editor loads, so it runs on your machine rather
than in Docker and `make ext` needs Node 22+. It is a shell today — activation,
the API client and **Show Version** — kept ready for the first editor feature.

## Develop it

Needs **Node.js 22+**. `make dev` runs the API and web app directly on your
machine — faster than the containers, and what you want day to day. It still
needs Postgres: `make migrate` starts it and applies the schema.

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `make dev`          | API on :4000, web on :5173, hot reload             |
| `make ext`          | Rebuild the extension on save                      |
| `make ext-package`  | Produce a `.vsix`                                  |
| `make verify`       | Everything CI runs — the gate before pushing       |
| `make test`         | Test every workspace with coverage thresholds      |
| `make build`        | Build every workspace, in dependency order         |
| `make lint`         | Type-check every workspace                         |
| `make format`       | Apply formatting                                   |
| `make up` / `down`  | Dev containers — source mounted, hot reload intact |
| `make up-prod`      | Built images behind nginx on :8080                 |
| `make build-images` | Build the production images without starting them  |
| `make logs` / `ps`  | Follow logs, show status                           |
| `make db-up`        | Start Postgres and SeaweedFS, wait for both        |
| `make migrate`      | Apply the schema                                   |
| `make psql`         | Open a psql shell against the local database       |
| `make reset`        | Stop everything and **delete** the data volumes    |

Run `make` on its own for the full list. Every target delegates to an npm
script, so `make test` and `npm test` cannot drift apart.

Scope a check to one workspace:

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

Notes:

- `make up-prod` serves one origin through nginx with `/api` proxied, matching
  the dev server, so cookie and CORS behaviour does not differ between the two.
- Ports are overridable: `API_PORT`, `WEB_PORT`, `WEB_PROD_PORT`,
  `POSTGRES_PORT`.
- SeaweedFS' S3 gateway is on :8333 and its filer browser on :8888.
  Credentials in `docker-compose.yml` are development values only.
- The extension host reloads on every rebuild
  (`debug.extensionHost.autoReload` in
  [`.vscode/settings.json`](./.vscode/settings.json)), so its in-memory state
  is lost and the tree refetches.
- The test suite needs no services: `npm run verify` passes with Docker
  stopped.

## Using `packages/core`

Dependency-free, and runs in a browser, in Node, or inside an editor extension.

It is **not on npm yet**. Consume it through the workspace, or from the tarball
attached to a [release](https://github.com/lunox-work/sandbox-factory/releases).
The import below is what publishing would enable:

```ts
import { checkHandle, normalizeHandle, toHandleStem } from "sandbox-factory";

normalizeHandle("  Acme-Corp  "); // { status: "ok", handle: "acme-corp" }
normalizeHandle("no spaces!"); // { status: "invalid", reason: "…" }
toHandleStem("dana@example.test"); // "dana"
checkHandle("ok-name"); // { status: "ok", handle: "ok-name" }
```

Users and organizations draw handles from one namespace, so what counts as a
valid handle is decided here and nowhere else.

## Which version am I running?

Every surface reports `<version>+<short sha>`, e.g. `1.4.2+7f3a9c1`: the web
app in its footer, the API at `GET /version`, the extension through its **Show
Version** command.

That string identifies a build but proves nothing — the running code only
repeats what the build stamped into it. What proves something is the
signature: every deployment attests the image it runs and every file it
publishes, so anyone can check that the live site serves code built from this
repository, without trusting us:

```bash
./scripts/verify-production.sh
```

See [docs/versioning.md](./docs/versioning.md) for how this is wired, what it
deliberately does **not** prove, and why the commit sha rather than the version
is the real identifier.

## Documentation

| Document                                       | Covers                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| [CONTRIBUTING.md](./CONTRIBUTING.md)           | Dev setup and pull request process                  |
| [AGENTS.md](./AGENTS.md)                       | Rules for coding agents                             |
| [docs/architecture.md](./docs/architecture.md) | Workspace layout, dependency rules, auth            |
| [docs/ci.md](./docs/ci.md)                     | Workflows, branch protection, releases              |
| [docs/versioning.md](./docs/versioning.md)     | Build provenance, and verifying a release           |
| [docs/github-apps.md](./docs/github-apps.md)   | Installed apps and settings that live outside files |
| [scripts/README.md](./scripts/README.md)       | `ship.sh` and `rotate-token.sh`                     |
| [infra/README.md](./infra/README.md)           | The AWS deployment                                  |

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md); by participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md). Report vulnerabilities privately — see
[SECURITY.md](./SECURITY.md) — never in a public issue.

## License

[MIT](./LICENSE) © feversoul
