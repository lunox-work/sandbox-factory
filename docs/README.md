# Engineering documentation

Start with [AGENTS.md](../AGENTS.md) and any `CONVENTIONS.local.md`, then open
only the reference for the task below. This index describes the current code;
product proposals and historical explainers are optional design context.

## Current capabilities

- A bounty is made in three steps, **Scope**, **Price** and **Sandbox**, and
  its status is the last one done: **New**, **Scoped**, **Priced** or
  **Live**. The words are defined once, in
  [architecture.md](./architecture.md#vocabulary).
- Bounties are written here, imported from a connected repository's GitHub
  issue, or imported from a connected Jira board's free backlog scan (scope
  and Jira context filled). Nothing is sized until someone sizes a ticket
  or asks for a whole board.
- A bounty names no repository: its work may touch any the workspace has
  connected, and sizing says which. Jira is synced into it on request as
  versioned context; repository documents are pinned at a built commit each.
  Every step records the versions it used and reports drift.
- Onboarding is the only page offered until every checklist step is done; it
  holds a repository's x-ray and a board's backlog scan.
- Five context builders describe a repository snapshot: Graphify,
  abstractions, data model, documents and brief. Scope and fixtures agents
  propose; slice, build and baseline decide. Sandbox versions are sliced from
  a repository or generated from the bounty's text, built, and published to
  a date.
- The available evaluator is opt-in `local-process`, for development; it is
  not an isolation boundary. With the default provider `none`, builds fail
  closed.
- `/api/v1` is the public API for workspace API tokens (`lnx_…`, scoped,
  one workspace each) on the routes its registry lists, described at
  `GET /api/v1/openapi.json`. Command-line clients sign in by device flow
  and mint their own token, and revoke it on logout. MCP clients sign in
  over OAuth 2.1, consenting for one workspace, and read and post work at
  `/mcp` (toolsets `/mcp/duediligence`, `/mcp/carveout`). Creates take an
  `Idempotency-Key`; machine credentials' changes are audited; signed
  webhooks report finished runs, prices, builds, publications and failed
  writebacks. Owners and admins manage tokens and connected apps at
  `/o/:slug/developers`. Not built: the portal's webhook, CI and audit
  pages. See [Public API conventions](./architecture.md#public-api-conventions).
- The VS Code extension can run a local task. Its sign-in flow is not built.
- Not built: contributor submission, adjudication, escrow, payouts,
  reputation, merge-back, Slack and knowledge integrations. See the
  [roadmap](./roadmap.md).

## Read by task

| Task                          | Reference                                                                                                                                 | Source entry points                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and daily development   | [Run it](../README.md#run-it), [development](./development.md)                                                                            | `Makefile`, `docker-compose.yml`, `package.json`                                                                                                   |
| Auth and ownership            | [Auth](./architecture.md#auth), [organizations](./architecture.md#organizations)                                                          | `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `packages/db/src/schema.ts`                                                                      |
| Public API and tokens         | [Auth](./architecture.md#auth), [conventions](./architecture.md#public-api-conventions)                                                   | `apps/api/src/credentials.ts`, `apps/api/src/public-api/`, `apps/api/src/api-tokens/`, `apps/api/src/idempotency.ts`, `apps/api/src/audit/`        |
| Webhooks out                  | [Webhooks](./architecture.md#webhooks)                                                                                                    | `apps/api/src/webhooks/`, `packages/db/src/webhooks.ts`, `packages/shared/src/webhooks.ts`                                                         |
| OAuth provider and MCP        | [Auth](./architecture.md#auth), [MCP](./architecture.md#mcp)                                                                              | `apps/api/src/oauth/`, `apps/api/src/mcp/`, `apps/web/src/features/developers/OAuthConsent.tsx`                                                    |
| Bounties and Jira             | [Bounties](./architecture.md#bounties)                                                                                                    | `apps/api/src/bounties/routes.ts`, `apps/api/src/jira/`, `packages/core/src/bounty.ts`                                                             |
| Pricing and specs             | [Pricing](./architecture.md#pricing)                                                                                                      | `packages/core/src/sizing.ts`, `packages/core/src/pricing/`, `apps/api/src/sizing/`, `apps/api/src/pricing/`                                       |
| GitHub snapshots              | [GitHub](./architecture.md#github), [App setup](./github-apps.md)                                                                         | `apps/api/src/github/`, `packages/github/`                                                                                                         |
| Analysis and sandboxes        | [Worker contract](../apps/worker/README.md)                                                                                               | `apps/worker/src/tools/`, `apps/api/src/sandbox/routes.ts`, `packages/core/src/slice/`, `packages/core/src/context/`, `packages/core/src/sandbox/` |
| Web and extension             | [Web app](./architecture.md#web-app), [extension](./architecture.md#the-extension), [extension setup](../README.md#the-vs-code-extension) | `apps/web/src/App.tsx`, `apps/web/src/routes.ts`, `apps/extension/src/commands.ts`, `packages/client/`                                             |
| Tests and coverage            | [Testing](./development.md#testing)                                                                                                       | Workspace `package.json`, `test/`, `tooling/coverage-guard/`                                                                                       |
| CI, PRs and releases          | [CI](./ci.md), [shipping](../scripts/README.md)                                                                                           | `.github/workflows/`, `.github/main-ruleset.json`, `scripts/ship.sh`                                                                               |
| Build identity and deployment | [Versioning](./versioning.md), [AWS](../infra/README.md)                                                                                  | `scripts/build-info.mjs`, `infra/`, `.github/workflows/cd.yml`                                                                                     |

## Workspaces

Apps use packages; apps never import each other. Core depends only on
carveout's pure `carveout/pseudonyms` entry.
The full import rules are in [architecture](./architecture.md#dependency-direction).

| Directory                | Workspace name              | Responsibility                                                                      |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| `packages/core`          | `sandbox-factory`           | Domain rules: handles, bounties, pricing, selection, analysis, slices and sandboxes |
| `packages/shared`        | `@sandbox-factory/shared`   | Wire schemas and shared DTOs                                                        |
| `packages/db`            | `@sandbox-factory/db`       | Drizzle schema, migrations, Postgres and object storage                             |
| `packages/jira`          | `@sandbox-factory/jira`     | Atlassian OAuth and Jira client                                                     |
| `packages/github`        | `@sandbox-factory/github`   | GitHub App credentials, API and webhooks                                            |
| `packages/client`        | `@sandbox-factory/client`   | Platform-neutral typed API client                                                   |
| `apps/api`               | `@sandbox-factory/api`      | Hono API and background orchestration                                               |
| `apps/web`               | `@sandbox-factory/web`      | React dashboard                                                                     |
| `apps/worker`            | `@sandbox-factory/worker`   | Private analysis, scope/fixture agents and sandbox builds                           |
| `apps/extension`         | `sandbox-factory-vscode`    | VS Code task commands                                                               |
| `tooling/tsconfig`       | `@sandbox-factory/tsconfig` | Shared compiler settings                                                            |
| `tooling/coverage-guard` | `@sandbox-factory/coverage` | Detect source files omitted from coverage                                           |

## Keeping context small

Global rules live in AGENTS.md; each contract lives in one reference and is
linked, not copied. Detail about how one function works belongs in a comment
beside it, not here. Update the reference when behavior changes, and verify
against source when they disagree. Proposals stay in the roadmap, labeled as
such.
