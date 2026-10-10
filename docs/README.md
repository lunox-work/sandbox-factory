# Engineering documentation

Start with [AGENTS.md](../AGENTS.md) and any `CONVENTIONS.local.md`, then open
only the reference for the task below. This index describes the current code;
product proposals and historical explainers are optional design context.

## Current capabilities

- Native bounties and optional Jira imports share proposals, spec review and pricing.
- A bounty names no repository: its work may touch any the workspace has
  connected, and sizing says which. Its Jira issue and the workspace's
  repositories are synced into it on request as versioned context: the
  issue's fields and the repositories' documents. Sizing
  and sandbox generation are given it, and each step says which versions it used.
- Until a workspace has done every onboarding step, onboarding is the only
  page the rail offers; after, home and bounties are, and onboarding is not.
  Onboarding has the ways in, the getting-started checklist, a GitHub
  repository's x-ray and, once Jira is connected, a board's free backlog scan
  for the six kinds of outsourceable work. Nothing is sized until someone
  sizes a ticket, or asks for a whole board; where GitHub is offered, neither
  is allowed until a repository is connected.
- A bounty is made in three steps, **Scope**, **Price** and **Sandbox**,
  and its status is the last one done: **New**, **Scoped**, **Priced** or
  **Live**. The words are defined once, in
  [architecture.md](./architecture.md#vocabulary).
- A connected board's scan is imported as bounties with their scope and
  Jira context filled, and nothing sized. The bounty list filters by
  category, by status and by board; a board's view is that list, where its
  issues are searched and added.
- GitHub supplies private repository snapshots. Five context builders describe a
  snapshot from a repository's own page: Graphify, dependency-cruiser,
  DeepWiki-Open, abstractions (every module's surface) and data model (the
  entities a schema or migrations declare). Scope, slice and fixture tools
  prepare the source for versioned private sandbox builds; the scope and
  fixtures agents read the last two.
- Builds generate a runnable project and check its baseline. The available
  evaluator is opt-in `local-process`, for development; it is not an isolation
  boundary. With the default provider `none`, builds fail closed.
- The VS Code extension can run a local task. Its sign-in flow is not built.
- Public task publication, contributor submission/adjudication, escrow, payouts,
  reputation and automated merge-back remain future work. Slack and knowledge
  integrations are not implemented.

## Read by task

| Task                          | Reference                                                                                                             | Source entry points                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and daily development   | [Run it](../README.md#run-it), [development](./development.md)                                                        | `Makefile`, `docker-compose.yml`, `package.json`                                                                                                   |
| Auth and ownership            | [Auth](./architecture.md#auth), [organizations](./architecture.md#organizations)                                      | `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `packages/db/src/schema.ts`                                                                      |
| Bounties and Jira             | [Bounties](./architecture.md#bounties)                                                                                | `apps/api/src/bounties/routes.ts`, `apps/api/src/jira/`, `packages/core/src/bounty.ts`                                                             |
| Pricing and specs             | [Pricing](./architecture.md#pricing)                                                                                  | `packages/core/src/sizing.ts`, `packages/core/src/pricing/`, `apps/api/src/sizing/`, `apps/api/src/pricing/`                                       |
| GitHub snapshots              | [GitHub](./architecture.md#github), [App setup](./github-apps.md)                                                     | `apps/api/src/github/`, `packages/github/`                                                                                                         |
| Analysis and sandboxes        | [Worker contract](../apps/worker/README.md)                                                                           | `apps/worker/src/tools/`, `apps/api/src/sandbox/routes.ts`, `packages/core/src/slice/`, `packages/core/src/context/`, `packages/core/src/sandbox/` |
| Web and extension             | [Dependency direction](./architecture.md#dependency-direction), [extension setup](../README.md#the-vs-code-extension) | `apps/web/src/App.tsx`, `apps/web/src/routes.ts`, `apps/extension/src/commands.ts`, `packages/client/`                                             |
| Tests and coverage            | [Testing](./development.md#testing)                                                                                   | Workspace `package.json`, `test/`, `tooling/coverage-guard/`                                                                                       |
| CI, PRs and releases          | [CI](./ci.md), [shipping](../scripts/README.md)                                                                       | `.github/workflows/`, `.github/main-ruleset.json`, `scripts/ship.sh`                                                                               |
| Build identity and deployment | [Versioning](./versioning.md), [AWS](../infra/README.md)                                                              | `scripts/build-info.mjs`, `infra/`, `.github/workflows/cd.yml`                                                                                     |

## Workspaces

Apps use packages; apps never import each other. Core has no dependencies.
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

Keep global rules in AGENTS and feature details in their linked reference.
Update the relevant reference when behavior changes; avoid copying the same
contract into several docs. Verify commands and rules against source when they
disagree. Keep proposed features labeled as proposals and historical material
out of the default reading path.
