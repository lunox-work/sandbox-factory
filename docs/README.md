# Engineering documentation

Start with [AGENTS.md](../AGENTS.md) and any `CONVENTIONS.local.md`, then open
only the reference for the task below. This index describes the current code;
product proposals and historical explainers are optional design context.

## Current capabilities

- Native tickets and optional Jira imports share proposals, spec review and pricing.
- GitHub supplies private repository snapshots. Graphify, scope, slice and fixture
  tools prepare the source for versioned private sandbox builds.
- Builds generate a runnable project and check its baseline. The available
  evaluator is opt-in `local-process`, for development; it is not an isolation
  boundary. With the default provider `none`, builds fail closed.
- The VS Code extension can run a local task. Its sign-in flow is not built.
- Public task publication, contributor submission/adjudication, escrow, payouts,
  reputation and automated merge-back remain future work. Slack and knowledge
  integrations are not implemented.

## Read by task

| Task                          | Reference                                                                                                             | Source entry points                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Setup and daily development   | [Run it](../README.md#run-it), [development](./development.md)                                                        | `Makefile`, `docker-compose.yml`, `package.json`                                                                     |
| Auth and ownership            | [Auth](./architecture.md#auth), [organizations](./architecture.md#organizations)                                      | `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `packages/db/src/schema.ts`                                        |
| Tickets and Jira              | [Tickets](./architecture.md#tickets)                                                                                  | `apps/api/src/tickets/routes.ts`, `apps/api/src/jira/`, `packages/core/src/ticket.ts`                                |
| Pricing and specs             | [Pricing](./architecture.md#pricing)                                                                                  | `packages/core/src/bounty.ts`, `packages/core/src/pricing/`, `apps/api/src/sizing/`, `apps/api/src/bounty/`          |
| GitHub snapshots              | [GitHub](./architecture.md#github), [App setup](./github-apps.md)                                                     | `apps/api/src/github/`, `packages/github/`                                                                           |
| Analysis and sandboxes        | [Worker contract](../apps/worker/README.md)                                                                           | `apps/worker/src/tools/`, `apps/api/src/sandbox/routes.ts`, `packages/core/src/slice/`, `packages/core/src/sandbox/` |
| Web and extension             | [Dependency direction](./architecture.md#dependency-direction), [extension setup](../README.md#the-vs-code-extension) | `apps/web/src/App.tsx`, `apps/web/src/routes.ts`, `apps/extension/src/commands.ts`, `packages/client/`               |
| Tests and coverage            | [Testing](./development.md#testing)                                                                                   | Workspace `package.json`, `test/`, `tooling/coverage-guard/`                                                         |
| CI, PRs and releases          | [CI](./ci.md), [shipping](../scripts/README.md)                                                                       | `.github/workflows/`, `.github/main-ruleset.json`, `scripts/ship.sh`                                                 |
| Build identity and deployment | [Versioning](./versioning.md), [AWS](../infra/README.md)                                                              | `scripts/build-info.mjs`, `infra/`, `.github/workflows/cd.yml`                                                       |

## Workspaces

Apps use packages; apps never import each other. Core has no dependencies.
The full import rules are in [architecture](./architecture.md#dependency-direction).

| Directory                | Workspace name              | Responsibility                                                                     |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `packages/core`          | `sandbox-factory`           | Domain rules: handles, tickets, pricing, selection, analysis, slices and sandboxes |
| `packages/shared`        | `@sandbox-factory/shared`   | Wire schemas and shared DTOs                                                       |
| `packages/db`            | `@sandbox-factory/db`       | Drizzle schema, migrations, Postgres and object storage                            |
| `packages/jira`          | `@sandbox-factory/jira`     | Atlassian OAuth and Jira client                                                    |
| `packages/github`        | `@sandbox-factory/github`   | GitHub App credentials, API and webhooks                                           |
| `packages/client`        | `@sandbox-factory/client`   | Platform-neutral typed API client                                                  |
| `apps/api`               | `@sandbox-factory/api`      | Hono API and background orchestration                                              |
| `apps/web`               | `@sandbox-factory/web`      | React dashboard                                                                    |
| `apps/worker`            | `@sandbox-factory/worker`   | Private analysis, scope/fixture agents and sandbox builds                          |
| `apps/extension`         | `sandbox-factory-vscode`    | VS Code task commands                                                              |
| `tooling/tsconfig`       | `@sandbox-factory/tsconfig` | Shared compiler settings                                                           |
| `tooling/coverage-guard` | `@sandbox-factory/coverage` | Detect source files omitted from coverage                                          |

## Keeping context small

Keep global rules in AGENTS and feature details in their linked reference.
Update the relevant reference when behavior changes; avoid copying the same
contract into several docs. Verify commands and rules against source when they
disagree. Keep proposed features labeled as proposals and historical material
out of the default reading path.
