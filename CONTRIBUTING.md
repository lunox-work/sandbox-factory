# Contributing to sandbox-factory

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Contributions are accepted under the [MIT License](./LICENSE).

## Before you start

- **Bugs** — open an issue with a minimal reproduction first, so we can confirm
  it is a bug and not expected behavior.
- **Features** — open an issue describing the problem first. A surprise feature
  PR is much likelier to be declined, however good the code.
- **Small fixes** (typos, docs, obvious one-liners) — just send the PR.

## Setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/lunox-work/sandbox-factory.git
cd sandbox-factory
npm ci
npm run verify   # lint, format check, build, test — needs no services
```

Use `npm ci`, not `npm install`, unless you are deliberately changing
dependencies — `npm install` rewrites `package-lock.json`.

To run the app, follow [Run it](./README.md#run-it) in the README for the
environment file and OAuth credentials, then:

```bash
make migrate   # starts Postgres and applies the schema
npm run dev    # API on :4000, dashboard on :5173, both watching
```

The API will not boot without `DATABASE_URL` and the auth variables. The
in-memory store is a test double, not a way to run without a database.

[docs/architecture.md](./docs/architecture.md) explains what lives where and
which workspace may import which — worth five minutes before your first change,
because the type checker enforces the dependency rules.

## Working on a change

1. Branch off `main`: `git checkout -b fix/short-description`
2. Make the change, with a test that fails before it and passes after.
3. Run `npm run verify`. CI runs the same thing, and a `pre-push` hook runs it
   before any push succeeds. It enforces per-workspace coverage thresholds (90%
   for packages, 80% for the API), so new code needs tests in the same change.
   While iterating, scope to one workspace with
   `npx turbo run lint test --filter=<name>`.
4. Push and open a pull request.

## Pull requests

- **Title the PR as a [Conventional Commit](https://www.conventionalcommits.org/)**
  — `fix: handle empty input`, `feat: add retry option`, `docs: clarify setup`.
  PRs are squash-merged, so the title becomes the commit and decides the
  release: `fix:` is a patch, `feat:` a minor, `docs:`/`chore:` none.
- **A green PR merges itself.** Auto-merge arms on every PR and no approval is
  required. Open a **draft** if you want eyes on it first.
- Unresolved review threads block the merge, including CodeRabbit's.
- One logical change per PR. Fill in the template and link the issue it closes.
- Update affected docs in the same PR.

Maintainers may decline a PR that does not fit the project's direction — open an
issue first if you are unsure.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
