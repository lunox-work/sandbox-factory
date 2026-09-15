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
npm install
npm test
```

## Working on a change

1. Branch off `main`: `git checkout -b fix/short-description`
2. Make the change, with a test that fails before it and passes after.
3. Run the full check locally — CI runs the same thing, and a `pre-push` hook
   runs it automatically before any push succeeds:
   ```bash
   npm run verify
   ```
   This includes an 80% coverage threshold, so new code needs tests in the same
   change.
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
