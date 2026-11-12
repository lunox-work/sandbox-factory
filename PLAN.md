# Plan: API/MCP portal, and duediligence + carveout working with the platform

Status: proposal, 2026-11-12. Delete this file when it lands; contracts move
into [architecture.md](./docs/architecture.md), the
[worker contract](./apps/worker/README.md) and the portal's own reference.

Companion plans: `public/duediligence/PLAN.md`, `public/carveout/PLAN.md`.

## The goal

platform.lunox.work keeps its hosted web experience and adds a developer
portal, `platform.lunox.work/developers`. From there a workspace connects
Jira and GitHub itself, gets an API token or an MCP connection, and posts
work into the platform from code, CI or an agent: tickets, specs,
slices and submissions. Every action in the web app has a public API route,
and every MCP tool is a thin wrapper over one route.

## Where things stand

| Fact                                                                                                         | Where                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| About 110 routes under `/api/v1`, all private to the web app and extension                                   | `apps/api/src/routes.ts`, `*/routes.ts`                                                         |
| Auth: session cookie or `bearer()` session token only; no API tokens, OAuth provider or device login         | `apps/api/src/auth.ts:18,587`                                                                   |
| better-auth 1.7.7 ships `device-authorization` and `jwt` plugins, both unused                                | `apps/api/node_modules/better-auth/dist/plugins`                                                |
| Wire schemas are zod, in one package; no OpenAPI is generated                                                | `packages/shared/src`                                                                           |
| A typed fetch-only client exists but is private                                                              | `packages/client` (`@sandbox-factory/client`, `private: true`)                                  |
| One SSE stream per workspace reports run and proposal changes (`LISTEN`)                                     | `apps/api/src/events.ts`                                                                        |
| No MCP server; CloudFront forwards only `/api/*`, `/version` and `/health`                                   | `infra/cloudfront.tf:127-172`                                                                   |
| The hosted worker has no evaluator (`EVALUATION_PROVIDER` unset → `none`), so every hosted build fails today | `infra/ecs.tf:209-220`, `apps/worker/src/env.ts:57,113`                                         |
| Not built: submissions, contributors, marketplace listing, GitHub issue import, webhooks out                 | [docs/README.md](./docs/README.md#current-capabilities), `packages/db/src/submissions.ts` shape |
| Worker pins `typescript-compiler: npm:typescript@5.9.3`, the same as carveout                                | `apps/worker/package.json:22`                                                                   |

## 1. The portal

Web pages under `apps/web` at `/developers`, for owners and admins unless
noted:

| Page           | Holds                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Status of the workspace's GitHub and Jira connections (links to the existing connect flows), quickstart for API, MCP and CLIs |
| API tokens     | Create, name, scope, expire and revoke workspace tokens; shown once, stored hashed; last used at and from                     |
| Connected apps | OAuth clients that hold a grant (Claude Code, Cursor, the CLIs): scopes, last use, revoke                                     |
| MCP            | The server URLs, `claude plugin install …`, `claude mcp add --transport http …`, Cursor/Codex snippets, a test call           |
| API reference  | Rendered from the generated OpenAPI document (`/api/v1/openapi.json`), with try-it against the caller's own workspace         |
| Webhooks       | Endpoints, event types, signing secret, delivery log with redeliver                                                           |
| CI             | The GitHub Action for judging pull requests, with OIDC trust per connected repository (no secret to paste)                    |
| Usage          | Runs, model spend and evaluator minutes against the workspace's quota                                                         |
| Audit log      | Every token-authenticated call that changed something: who, which token or client, what                                       |

## 2. What every public route needs (foundation)

Build these once, before exposing any resource:

1. **Machine auth**, three ways into one principal `{ user, organization, scopes, via }`:
   - _Workspace API tokens_ (`lnx_…`), org-bound, scoped, hashed, for scripts and CI.
   - _OAuth 2.1 provider_ (authorization code + PKCE, dynamic client
     registration, `/.well-known/oauth-authorization-server` and
     `/.well-known/oauth-protected-resource`) for MCP clients and third
     parties. Consent picks one organization.
   - _Device authorization_ (the installed plugin) for `duediligence login`
     and `carveout login`.
   - _GitHub Actions OIDC_: a token whose `repository` claim names a
     repository the workspace connected is accepted for `judge` on that
     repository only.

   The guard keeps the existing rules: organization from the principal or
   path after `requireMembership`, owner first in every store call, 404 not 403. Session cookies stay web-only; a token never reaches cookie routes.

2. **Scopes**: `workspace:read`, `integrations:write`, `bounties:write`,
   `pricing:write`, `specs:write`, `sandboxes:write`, `submissions:write`,
   `judge`, `webhooks:write`. Owner/admin-only routes stay so whatever the
   scope.
3. **OpenAPI** generated from the zod schemas in `packages/shared` (routes
   declare request and response schemas; a test fails when a public route
   has none). Publish `packages/client` as the SDK (`@lunox-work/client`),
   generated or checked against the document.
4. **Conventions**: `Idempotency-Key` on every `POST` that creates
   something; cursor paging as `paging.ts` already does; one error shape
   `{ error: { code, message } }` with the existing codes
   (`task_not_ready`, `published`, …); per-token rate limits beside
   `MAX_ACTIVE_RUNS_PER_ORG`; `Lunox-Api-Version` header for breaking
   changes.
5. **Webhooks out**: the `events.ts` channel feeds a delivery table and a
   sender with retries and HMAC signatures. Events: `run.finished`,
   `proposal.priced`, `sandbox.build.finished`, `sandbox.published`,
   `submission.judged`, `writeback.failed`.
6. **Infra**: CloudFront behaviors, uncached with all headers forwarded,
   for `/mcp*` and `/.well-known/oauth-*`; MCP answers stateless JSON
   (Fargate Spot restarts, 60 s read timeout), long work returns a run id.
   New variables in `env.ts`, `test/env-surface.test.ts` and all three
   `.env*` files.

## 3. Where API and MCP get built

Status: **E** exists in `/api/v1`, needs only the foundation to go public;
**C** exists, needs a change; **N** new. Every MCP tool is a wrapper over
the route beside it. The tool lives in a toolset; each toolset is one
endpoint: `/mcp` (all), `/mcp/duediligence`, `/mcp/carveout`.

### Workspace and integrations

| Resource            | API                                                                          | St. | MCP tool (toolset)                  |
| ------------------- | ---------------------------------------------------------------------------- | --- | ----------------------------------- |
| Me, workspaces      | `GET /me`, `/me/orgs`, `/orgs/:orgId`, `/members`                            | E   | `list_workspaces` (all)             |
| GitHub connect      | `GET /orgs/:orgId/github/connect` → install URL; `connections`, `available`  | E   | `connect_github` returns the URL    |
| Repositories        | `GET/DELETE /github/repositories`, `/branches`, `/snapshots/:id`, `/tree`    | E   | `list_repositories`, `get_snapshot` |
| Jira connect        | `GET /jira/connect`, `connections`, `connections/:id/boards`, `.../sync`     | E   | `connect_jira` returns the URL      |
| Jira boards, issues | `GET/POST/PATCH /jira/boards`, `/issues/:key`, `/backlog-preview`, `/search` | E   | `list_boards`, `search_issues`      |
| Settings, rate card | `GET/PATCH /settings`, `GET/PUT /rate-card`                                  | E   | (portal only)                       |
| Tokens, clients     | `/orgs/:orgId/tokens`, `/oauth/clients`                                      | N   | (portal only, never MCP)            |
| Webhooks            | `/orgs/:orgId/webhooks`, `/deliveries`, `/redeliver`                         | N   | (portal only)                       |
| Usage, audit        | `GET /orgs/:orgId/usage`, `/audit`                                           | N   | `get_usage` (all)                   |

Connecting stays a browser step: GitHub App install and Atlassian consent
cannot be done by a token. API and MCP return the URL; the portal page
shows the result.

### Posting work: bounties, pricing, specs

| Resource                    | API                                                                                      | St. | MCP tool (toolset)                              |
| --------------------------- | ---------------------------------------------------------------------------------------- | --- | ----------------------------------------------- |
| Bounty from text            | `POST /orgs/:orgId/bounties`                                                             | E   | `post_bounty` (all, duediligence)               |
| Bounty from Jira            | `POST /jira/boards/:id/issues`, `POST /jira/boards/:id/runs`                             | E   | `import_jira_issue`                             |
| Bounty from GitHub issue    | `POST /orgs/:orgId/bounties` with `{ source: { github_issue: url } }`                    | N   | `import_github_issue`                           |
| Bounty read, edit, approve  | `GET/PATCH/DELETE /bounties/:id`, `/versions`, `/approve`, `/unapprove`                  | E   | `get_bounty`, `list_bounties`                   |
| Sizing and proposal         | `GET /bounties/:id/sizing`, `POST /bounties/:id/propose`                                 | E   | `size_bounty`                                   |
| Proposals                   | `GET /proposals`, `/:id`, `/spec`, `/profile`, `/spec/revisions`                         | E   | `get_proposal`                                  |
| Approve, reprice, respec    | `POST /proposals/:id/approve`, `/unapprove`, `/resize`, `/rubric`, `/reprice`, `/respec` | E   | `respec`; approve stays a person's act (portal) |
| Jira writebacks             | `POST /writebacks/:id/retry`, `/reconcile`, `/cancel`                                    | E   | (portal only)                                   |
| Spec in Gherkin + decisions | `GET/PUT /proposals/:id/spec/gherkin`, `GET /…/decisions`                                | N   | `draft_spec`, `get_decisions` (duediligence)    |
| Decision confirmation       | `POST /…/decisions/confirm` (session only, never a token)                                | N   | `confirm_link` returns the web page             |
| Upload a confirmed spec     | `POST /orgs/:orgId/specs` (a duediligence spec folder, confirmed locally)                | N   | (CLI: `duediligence push`)                      |

### Sandboxes and slices

| Resource              | API                                                                                             | St. | MCP tool (toolset)                        |
| --------------------- | ----------------------------------------------------------------------------------------------- | --- | ----------------------------------------- |
| Analysis and context  | `POST /repositories/:id/runs`, `/builds`, `/scope`; `GET /runs/:id`, `/artifacts`, `/log`       | E   | `get_run`, `analyse_repository`           |
| Sandbox start, source | `POST /sandboxes/start`, `PUT /:id/source`, `POST /:id/starter`                                 | E   | `start_sandbox`                           |
| Slice plan            | `POST /repositories/:id/slice-plan` (carveout `plan()`, no cut)                                 | N   | `plan_slice` (carveout)                   |
| Slice cut, approve    | `GET/POST /sandboxes/:id/slice`, `/slice/approve`                                               | C   | `cut_slice`; approve wide slice in portal |
| Upload a local slice  | `POST /orgs/:orgId/slices` (a public carveout folder; receipt stays local)                      | N   | (CLI: `carveout handoff --platform`)      |
| Versions, build       | `GET/POST/PATCH /sandboxes/:id/versions`, `/versions/:vid/build`, `/replay`                     | E   | `build_version`                           |
| Prepare hidden tests  | `POST /versions/:vid/prepare` (duediligence calibration on the slice)                           | N   | `prepare` (duediligence)                  |
| Publish               | `POST /versions/:vid/publish`, `/unpublish`                                                     | E   | (portal only: a person's act)             |
| Files                 | `GET /versions/:vid/files`, `/files/content` (owners: private too)                              | E   | `get_files` (public paths only)           |
| Handout, download     | `GET /versions/:vid/handout` → stub, public suite, BRIEF.md, `hiddenSha256`, signed tarball URL | N   | `get_handout`, `download_slice`           |

### Submissions and judging

| Resource            | API                                                                                                   | St. | MCP tool (toolset)                      |
| ------------------- | ----------------------------------------------------------------------------------------------------- | --- | --------------------------------------- |
| Submit              | `POST /versions/:vid/submissions` (a patch, a returned folder or a commit on a connected repo)        | N   | `submit_patch` (carveout), `judge` (dd) |
| Verdict             | `GET /submissions/:id` → `passed / overfit / incomplete / regressed / refused`, counts, scenario keys | N   | `get_verdict`                           |
| Retry feedback      | `POST /submissions/:id/retry` (one, told only the scenario keys)                                      | N   | `retry`                                 |
| CI judge            | `POST /judge` with a GitHub OIDC token: head commit → check run on the PR                             | N   | (Action, not MCP)                       |
| Promote, merge-back | `POST /submissions/:id/promote` (hidden suite upstream), `/merge` (PR, gate 3)                        | N   | (portal only)                           |

### Marketplace (contributor side, later)

Not org-scoped: a contributor is any signed-in user. `GET /market/sandboxes`
(published, unexpired), `GET /market/sandboxes/:id`, `POST …/claims`,
`POST …/submissions`, `GET /me/submissions`. Toolset `/mcp/market`:
`browse_bounties`, `claim`, `get_handout`, `submit`, `get_verdict`. It
needs adjudication and payouts decided first; listed so the auth and
submission routes are built to serve both sides.

### Never on API or MCP

Approving a price or a wide slice, publishing, confirming decisions,
writeback cancel, token and client management, and the private faces
(alias table, receipts, hidden tests). These are a person's act in the web
app, or never leave the platform.

## 4. How duediligence and carveout work with the platform

Four joins, in the order they pay off:

1. **Engines in the worker.** Each repository exports a pure `./api`
   (companion plans). The worker pins exact versions behind a per-version
   `engine` field, so old drafts rebuild as before.
   - _carveout_ for slicing: its `src/core.ts` is the fork of this repo's
     `packages/core` slice and project modules, plus a TypeScript walk,
     carried tests (`--with-tests`) and the reverse path (`patch`,
     hand-off policy, test integrity). Phase A takes the walk, carried
     tests and `patch`; sandbox-factory keeps its stubs, mocks, fixtures,
     alias table and scans (the alias table reads the bounty's vocabulary,
     which carveout cannot see). Phase B picks one mock runtime.
   - _duediligence_ for hidden tests: spec in Gherkin with `Decided:`,
     separate blind writers, calibration (keep a hidden test only if it
     fails on the unchanged slice and passes a reference), scenario keys,
     `hiddenSha256` at publish, the five verdicts. The worker keeps its own
     agent loop and evaluator; it takes the prompts and rules.
2. **The CLIs as clients.** Both log in with the device flow
   (`duediligence login`, `carveout login`, token in `~/.lunox/credentials`)
   and talk to the public API through the published client:
   - `duediligence push <slug>` uploads a spec confirmed locally;
     `prepare --hosted` runs it on the platform; `ci --platform` judges a PR
     through `POST /judge` with GitHub OIDC instead of a seal in a private
     repository.
   - `carveout handoff --platform` cuts locally and uploads only the public
     folder (for a workspace that will not connect GitHub; the receipt never
     leaves the machine); `carveout patch --from <submission>` pulls a
     submission back and runs the same local policy.
3. **The plugins.** Skill plus `.mcp.json` pointing at
   `/mcp/duediligence` or `/mcp/carveout`; the skill uses hosted tools when
   signed in and the local CLI otherwise.
4. **One pipeline, both engines.** A bounty with a repository runs:
   carveout plans and cuts → the platform aliases and builds →
   duediligence writes and calibrates the suites on the slice → a person
   publishes → a contributor submits → carveout's policy and reverse path →
   duediligence's verdict on the reversed patch (gate 2) → the PR with the
   promoted hidden suite (gate 3). A bounty without a repository skips
   carveout and uses duediligence's new-module target (the starter path).

Shared terms, so neither repo invents its own:

| duediligence                    | carveout              | sandbox-factory                                  |
| ------------------------------- | --------------------- | ------------------------------------------------ |
| spec `<slug>`, `ticket.md`      |                       | bounty, approved proposal's spec revision        |
| `confirmed.json`                |                       | `decision_confirmation` (new)                    |
| `prepared.json`, `hiddenSha256` |                       | `sandbox_version_source` hidden tests + hash     |
|                                 | `carveout.json`, plan | `slice-manifest.json`, `boundary-contract.json`  |
|                                 | receipt               | alias table + import rewrites (private artifact) |
| handout                         | public folder         | `sandbox_version` public project                 |
| verdict                         | `patch` refusals      | `submission` outcome                             |
| seal                            |                       | the version itself, judged in place              |

Compatibility: the build manifest records both engine versions; the CLIs
send their version and the API answers `426` with the minimum it accepts.

## 5. Phases

| #   | Ships                                                                                                                              | Needs     | Done when                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Decisions below                                                                                                                    |           | Written into this plan                                                                                                                                                                                                  |
| 1   | Foundation 1–4 and 6; portal Overview, API tokens, Connected apps, MCP, API reference; all **E** rows as public, read tools in MCP | 0         | A token lists repositories; Claude Code signs in over OAuth and runs `list_bounties`; another workspace's id is 404; `verify` and `test:e2e` pass                                                                       |
| 2   | Posting: `post_bounty`, Jira and GitHub issue import, sizing, `draft_spec`, `confirm_link`; webhooks                               | 1         | A script posts a GitHub issue, gets `proposal.priced` by webhook, and a person confirms the decisions from the link                                                                                                     |
| 3   | Engines in the worker (section 4.1), behind `engine`                                                                               | libraries | Smoke fixture, `sandbox-factory` and `sixhelix` at a pinned commit and carveout's E6 corpus: same or fewer blockers, more carried tests, byte-identical round trip; calibration keeps at least as many tests as the CLI |
| 4   | Isolated evaluator                                                                                                                 | 0         | A hosted build is `ready` on the smoke fixture; a submission that reads the disk or opens a socket gets no secret and no network                                                                                        |
| 5   | Slices and suites: `plan_slice`, `cut_slice`, local slice upload, `prepare`, handout                                               | 3, 4      | From the CLI and from MCP, a connected repository goes to a published version with a calibrated hidden suite                                                                                                            |
| 6   | Submissions, verdicts, retry, CI judge with OIDC; CLI `push`, `ci --platform`, `patch --from`                                      | 5         | A PR on a connected repository gets a check with the verdict, and no hidden test's name or body reaches the PR, the agent's transcript or the CLI                                                                       |
| 7   | Promote and merge-back (gate 3); marketplace                                                                                       | 6         | The roadmap's merge-back "done when"; marketplace after payouts are decided                                                                                                                                             |

Phases 3 and 4 can run beside 1 and 2. The plugins ship `.mcp.json` after
phase 1 is live, and their skills call hosted write tools only after
phase 6.

## 6. Decisions to make first (phase 0)

1. **Who pays for hosted model sessions.** Locally duediligence runs on the
   person's `claude` login (about $1–7 a spec); hosted it is the platform's
   key. A per-workspace quota, or a workspace's own key stored like the
   integration credentials.
2. **Isolated evaluator.** E2B (the roadmap's choice) or one Fargate task
   per job with no egress, which needs VPC endpoints for image pulls.
3. **Token shape.** Workspace tokens only (recommended to start), or
   personal tokens across workspaces too.
4. **Public API versioning.** `/api/v1` made public as is (recommended,
   with the foundation's schema test), or a separate `/v1` façade.
5. **Portal access for members.** Owners and admins only (recommended), or
   members with read-only tokens.
