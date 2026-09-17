# Contributing to sandbox-factory

Thanks for taking the time to contribute. This document covers how to get set
up and what to expect when you open a pull request.

## Ground rules

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Contributions are accepted under the [MIT License](./LICENSE).

## Before you start

- **Bugs** — open an issue with a minimal reproduction before writing a fix, so
  we can confirm it is a bug and not expected behavior.
- **Features** — open an issue describing the problem first. A feature that
  arrives as a surprise PR is much likelier to be declined, no matter how good
  the code is.
- **Small fixes** (typos, docs, obvious one-liners) — just send the PR.

## Development setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
npm ci
npm run build
npm test
```

Use `npm ci` rather than `npm install` unless you are deliberately changing
dependencies — `npm install` rewrites `package-lock.json` and produces a noisy
diff.

To run the app while working on it:

```bash
npm run dev
```

That starts the API on port 4000 and the dashboard on port 5173, both watching
for changes. Open <http://localhost:5173>.

The API ships with an in-memory store, so there is no database to set up and no
`.env.development` to write. The API requires `DATABASE_URL` and will not boot without it — `make db-up` starts the local Postgres and `make db-url` prints the string.

### Finding your way around

This is a monorepo. [docs/architecture.md](./docs/architecture.md) explains what
lives where and which workspace may import which — worth five minutes before your
first change, because the dependency rules are enforced by the type checker and
it is easier to put code in the right place than to move it later.

## Working on a change

1. Branch off `main`: `git checkout -b fix/short-description`
2. Make the change, with a test that fails before it and passes after.
3. Run the full check locally — CI runs the same thing, and a `pre-push` hook
   runs it automatically before any push succeeds:
   ```bash
   npm run verify
   ```
   This builds and tests every workspace and enforces per-package coverage
   thresholds (90% for packages, 80% for the API), so new code needs tests in
   the same change. While iterating you can scope to one workspace and its
   dependencies with `npx turbo run lint test --filter=<name>`, but run the full
   `npm run verify` before pushing.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   `fix: handle empty input`, `feat: add retry option`, `docs: clarify setup`.
5. Push and open a pull request.

## Pull requests

- Keep each PR to one logical change. Several unrelated fixes in one PR are
  hard to review and hard to revert.
- Fill in the PR template, and link the issue it closes.
- Update the README and any affected docs in the same PR.
- CI must be green before review.

Maintainers may ask for changes or decline a PR that does not fit the project's
direction — please open an issue first if you are unsure.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
