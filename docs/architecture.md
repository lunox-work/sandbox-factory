# Architecture

The rules that hold across workspaces, with where each is enforced. Worker
output contracts are in [apps/worker/README.md](../apps/worker/README.md);
proposals are in the [roadmap](./roadmap.md).

## Dependency direction

Dependencies point from apps into packages. Apps also import `shared` and
`core` directly.

```
apps/web, apps/extension → client → shared → core
apps/api, apps/worker    → db → core
apps/api                 → jira → shared
apps/api, apps/worker    → github → shared
```

| Workspace         | May import       | Must never import           |
| ----------------- | ---------------- | --------------------------- |
| `packages/core`   | nothing          | anything at all             |
| `packages/shared` | `core`, `zod`    | `client`, any app, `node:*` |
| `packages/client` | `core`, `shared` | any app, `node:*`, `vscode` |
| `packages/db`     | `core`           | `client`, any app           |
| `packages/jira`   | `shared`         | `client`, any app, `node:*` |
| `packages/github` | `shared`         | `client`, any app           |
| `apps/*`          | any package      | another app                 |

`npm run lint:deps` (dependency-cruiser, part of `npm run lint`) enforces the
table, no unresolved imports and no runtime import cycles. The rules are in
[`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs); change its
`packageDependencies` allowlist with this table. Type-only cycles are allowed.
The one accepted runtime cycle (auth and organization schema modules) is in
`.dependency-cruiser-known-violations.json`; do not add to that file.

Three rules are load-bearing:

- **`packages/core` depends on `carveout/pseudonyms` alone**, carveout's pure
  entry (no `typescript`, no `node:*`; `.dependency-cruiser.cjs` allows
  nothing else). It is bundled into a browser, a Node server and an extension
  host, and is the one publishable package.
- **`packages/client` is platform-neutral**: `fetch` only. Its tsconfig sets
  `types: []`, so a `node:*` import fails to compile. `lib` includes `DOM`
  only for the web-standard fetch types.
- **Only `apps/extension` may import `vscode`.**

## Domain rules live in `packages/core`

| Area                                            | Source under `packages/core/src/`            |
| ----------------------------------------------- | -------------------------------------------- |
| Public handles and organization roles           | `handle.ts`, `roles.ts`                      |
| Bounty text and the steps built on it           | `bounty.ts`, `stages.ts`                     |
| Bounty selection, sizing and pricing            | `selection/`, `sizing.ts`, `pricing/`        |
| Tech stack catalog                              | `stack.ts`                                   |
| Repository facts, slices and context documents  | `repo/`, `analysis.ts`, `slice/`, `context/` |
| Sandbox provenance, generation and the contract | `sandbox/`                                   |

Users and organizations draw handles from one namespace (a personal
organization takes its owner's handle), so validity is decided once, in
`handle.ts`. `apps/api` calls `normalizeHandle()` before storing and maps a
refusal to 400; `apps/web` calls `isValidHandle()` and `toHandleStem()` in the
rename forms; `packages/shared`'s `handleSchema` refines core's rule rather
than restating it.

## TypeScript configuration

[`tooling/tsconfig`](../tooling/tsconfig) holds the strictness contract in
`base.json`. Every workspace extends one variant and keeps path settings
(`rootDir`, `outDir`, `include`) in its own config:

| Config           | For                    | Notable departure                         |
| ---------------- | ---------------------- | ----------------------------------------- |
| `base.json`      | platform-neutral code  | —                                         |
| `node.json`      | API and Node libraries | adds `@types/node`                        |
| `react.json`     | the web app            | `moduleResolution: Bundler`, DOM libs     |
| `extension.json` | the VS Code extension  | **CommonJS** — the host does not load ESM |

Import extensions follow the resolution mode: `NodeNext` workspaces (`core`,
`shared`, `client`, `db`, `api`, `worker`) write `from "./store.js"`; `web`
(`Bundler`) writes `from "./tree"`. `extension` bundles under `Bundler` but
tests under `NodeNext`, so it writes the `.js` form.

## Database and object storage

[`packages/db`](../packages/db) holds the Drizzle schema, migrations, the
owner-scoped stores and an S3 object store. Store contracts and
`NotFoundError` live here, not in `apps/api`, because a package may not
import an app. The server requires `DATABASE_URL`; fake stores and database
fixtures are for tests only.

Object storage is SeaweedFS' S3 gateway locally and an S3 bucket in
production, through one code path switched on by `S3_BUCKET`. Where they
differ: `forcePathStyle` is always on; SeaweedFS creates a bucket on first
write while Terraform creates the production bucket (`infra/s3.tf`); S3 needs
`s3:ListBucket` on the task role (`infra/iam.tf`) to answer a missing key with
404 rather than 403; SeaweedFS in compose checks no credentials, so local
development proves nothing about IAM.

## Auth

Better Auth, configured in `apps/api/src/auth.ts` and mounted at
`/api/auth/*`. Google, GitHub and Atlassian only; `emailAndPassword` is never
enabled. The fifteen auth tables (with the device plugin's `device_code` and
the OAuth provider's seven `oauth_*`) are bundled as `authSchema` in
`packages/db/src/auth-schema.ts`. Two naming rules
fail at runtime, not compile time, because the adapter resolves names by
string: exported consts are singular, column properties are camelCase.

- **Account linking is implicit; `trustedProviders` makes it safe.** A
  provider whose verified email matches an existing verified account merges
  into it. Adding a provider to the list is a security decision; the list is
  pinned by `apps/api/test/auth.test.ts`. Atlassian reports no
  `email_verified`, so `auth.ts` asserts one in `mapProfileToUser`; the
  accepted risk is that whoever controls an Atlassian account bearing an
  address can reach the account using it. Atlassian also needs the explicit
  `read:me` scope and `disableDefaultScope`, which lets the app be registered
  resource-level.
- **Two credentials, one session store.** The web app carries an httpOnly
  cookie; the extension sends `Authorization: Bearer` through the `bearer()`
  plugin. The guard in `routes.ts` hands Better Auth the whole header set.
  `packages/client` sends `credentials: "include"`.
- **`/api/v1` requires a credential**; `/health`, `/version`,
  `/api/auth/*` and `GET /api/v1/openapi.json` do not. `createApp` without
  `auth` serves 503 on `/api/*`, so a deploy missing the auth environment
  fails closed.
- **Every credential is one `Principal`** (`principal.ts`): user,
  organization, scopes and `via`, one of `session`, `token`, `device`,
  `oauth` and `contributor`. The guard is `credentials.ts`.
  - _Session_: cookie or `bearer()` token, no organization, every scope; roles
    decide, as before.
  - _Workspace API token_: `Authorization: Bearer lnx_…`, table `api_token`
    (SHA-256 only; secret shown once). Bound to one organization, any other
    `:orgId` is 404. Acts as its creator, who must still be owner or admin
    there on every use; `last_used_at` is written at most once a minute.
  - _Device session_: from Better Auth's `device-authorization` plugin
    (`duediligence`, `carveout`, approved at the web app's `/device`);
    `session.device_client_id` marks it. It reaches only `GET /me`,
    `GET /me/orgs` and `POST /orgs/:orgId/tokens/cli`, which mints that
    client's token (90 days, scopes within `CLI_CLIENTS`) and ends the
    session.
  - _OAuth access token_: `Authorization: Bearer lnxat_…`, issued by the
    OAuth provider below; resolves like an API token to its grant's
    organization and scopes, acting as the person who consented. Refused
    (401) once expired, its grant revoked, or that person is no longer owner
    or admin there. A contributor grant (below) is a contributor credential.
    Any other bearer is still Better Auth's session.
  - _Contributor token_: `Authorization: Bearer lnxc_…`, table
    `contributor_token` (SHA-256 only), a person's own, made, listed and
    revoked from their session (`/api/v1/me/contributor-tokens`,
    `api-tokens/contributor.ts`; default 90 days). No organization, no role
    read; holds `contributions:write` (`CONTRIBUTOR_SCOPES`, never in
    `API_SCOPES`).
- **Tokens are deny by default.** A bound credential reaches only routes in
  `apps/api/src/public-api/registry.ts`, matched by Hono pattern, holding the
  scope listed there (`API_SCOPES` in `packages/core/src/scopes.ts`). An
  unlisted route is 403 `not_public`; a missing scope 403
  `insufficient_scope`. A scope never widens a role. Each entry has an
  audience: contributor routes (`/contributions…`, `/invites/claim`) admit
  only contributor credentials (`lnxc_`, contributor grants), else 403
  `workspace_credential`; every other route only workspace credentials,
  else 403 `contributor_credential`; the self route either. A _self_ route
  (`scope: null`) needs none and acts only on the presenting credential:
  `POST /tokens/self/revoke` (`api-tokens/self.ts`) revokes an API or
  contributor token, or an OAuth access token and its refresh token (the
  grant stands); the
  CLIs' `logout` calls it. Token management
  (`/orgs/:orgId/tokens`) is session-only, for owners and admins; tokens
  never manage tokens. Each registry entry names its request and response
  schemas from `packages/shared`; `public-api/openapi.ts` serves them as
  OpenAPI 3.1, and `apps/api/test/public-api.test.ts` fails on an entry
  without schemas or a mounted route a token can reach outside the registry.
- **OAuth 2.1 provider** (`oauth/provider.ts`): Better Auth's
  `@better-auth/oauth-provider`, for MCP clients and other apps. Issuer
  `<BETTER_AUTH_URL>/api/auth`; discovery at
  `/.well-known/oauth-authorization-server[/api/auth]` and RFC 9728
  `/.well-known/oauth-protected-resource[/mcp…]` (`oauth/discovery.ts`); no
  `openid` scope, so no ID tokens or OIDC discovery. Authorization code with
  PKCE (S256 only), open dynamic registration (public clients allowed;
  clients are never managed from a session), refresh on `offline_access`,
  opaque 15-minute access tokens and `lnxrt_` refresh tokens stored as
  SHA-256. Sign-in is the web app's Google, GitHub and Atlassian.
- **A grant binds one organization.** The web app's `/oauth/consent`
  (`features/developers/OAuthConsent.tsx`) is both login and consent page:
  it shows the client, the requested scopes (all checked; the person may
  untick any) and the workspaces the person owns or administers, and posts
  `/api/auth/oauth2/consent` with the choice in `x-lunox-organization`.
  `consentReferenceId` admits only an owner's or admin's workspace and
  stores it as `reference_id` on the consent (the grant, unique per person,
  client and organization) and every token. Connected apps,
  `GET /orgs/:orgId/oauth/grants` and `POST …/grants/:id/revoke`, are
  session-only, owners and admins; revoking deletes the grant's tokens.
  **A contributor grant binds none**: an app asking `contributions:write`
  (`/mcp/contribute`) gets the contributor branch of the consent page (the
  person's contributions listed), which sends `contributor`
  (`CONTRIBUTOR_CONSENT`); the consent and tokens keep `reference_id` null
  (it is a foreign key to `organization`), only the contributor scope is
  admitted (`CONTRIBUTOR_SCOPE_ONLY`, `…_REQUIRED`), a workspace grant never
  holds it (`CONTRIBUTOR_SCOPE_FORBIDDEN`), and the guard keeps only
  `CONTRIBUTOR_SCOPES` from it. The person lists and revokes them at
  `/api/v1/me/contributor-grants`.
- **A session says who is asking, not what they may read.** Every store
  method takes the owner first and puts it in the query. Another owner's id
  returns 404, not 403, so ids cannot be enumerated.
- `account` has a unique `(provider_id, account_id)`; Better Auth throws on a
  collision rather than tolerating one.

## MCP

`apps/api/src/mcp/`: a remote MCP server on the SDK's Web-standard
Streamable HTTP transport, **stateless** (a server and transport per POST,
no session id, JSON responses; GET and DELETE answer 405). Endpoints are
toolsets: `POST /mcp` (every workspace tool), `/mcp/duediligence`,
`/mcp/carveout`, and `/mcp/contribute` (the contributor tools)
(`MCP_TOOLSETS` in `packages/core/src/scopes.ts`, shared with the web app's
MCP page). Each plugin's toolset carries its skill's whole hosted flow, from
finding or posting a bounty to the verdict. Read tools are GETs; write tools
post work (`post_bounty`, `import_github_issue`, `import_jira_issue`,
`size_bounty`, `respec`) and `connect_github`, `connect_jira` return the
connect route's link with what to do. Each tool declares its route's
scope; an endpoint's 401 challenge and protected-resource metadata ask for
the union over its toolset (`toolsetScopes`), so a plugin signed in through
`/mcp` can call every write its skill names. An `insufficient_scope` tool
error says to sign in again.
`get_decisions` reads a spec's decisions (its assumptions, keyed `d1…`,
hashed) and `confirm_link` returns the web page where a person confirms
them (`POST …/decisions/confirm`, a web session only; one
`decision_confirmation` per spec revision and hash). Until then, approving
the price, building or generating a version and publishing are 409
`decisions_unconfirmed`, checked against the spec the version's task froze;
a build's run names the confirmed decisions by hash (`decisionsSha256`) and
quotes them to its agents. `plan_slice`
(`POST …/repositories/:id/slices`), `start_sandbox`, `cut_slice` (a draft
version from a slice run) and `prepare` (its build, which writes and
calibrates hidden tests) post work; `get_handout`
(`GET …/versions/:vid/handout`) reads the public files, the count of hidden
tests the judge stages (`stagedHiddenTest`) and their commitment
`hiddenSha256` with `hiddenSha256Version` (2: recorded by the build as
`hiddenCommitment`, each test at its staged path; 1: a build without one
keeps its old hash, every `private/` file as `tests/private/…`), never a
hidden test's name or body;
`get_project_files` (`…/handout/files`) pages those files' contents so an
agent can write the project out.
`submit_patch`/`judge` (`POST …/versions/:vid/submissions`, a published
version only) store the files canonically (`submittedFilesText`) and queue a
`submission_grade` run; `get_verdict` reads duediligence's verdict
(passed, overfit, incomplete, refused), the counts and the failing
scenarios' keys; `retry` (`POST …/submissions/:sid/retry`) is a failed
submission's one retry (`submission.retry_of`, unique). The same files
again answer the submission already made and queue its run when it has
none (a `run_limit` 409 is `retryable`, with `Retry-After`). A grading run
that ends without a verdict leaves the submission `errored` with a fixed
`errorCode` (`SUBMISSION_ERRORS`); retried with its own files, or
`POST …/submissions/:sid/regrade` (`regrade`, `submissions:write`), its run
is queued again in place, within the run's attempts, without spending the
retry. `?dryRun=1` on a `files[]` submission or retry answers the preview a
zipped folder gets, storing nothing. `create_contributor_invite` wraps
`POST …/versions/:vid/invites`. A workspace
that will not connect its repository uploads a public, pseudonymised
carveout hand-off folder instead (`carveout handoff --platform`,
`POST …/sandboxes/uploads`, `sandboxes:write`, owners and admins; the MCP
tool `upload_handoff` sends nothing: it checks the bounty and answers the
`carveout login` and `carveout handoff … --platform … --bounty …` commands,
since the folder is renamed on the maintainer's machine by a receipt that
stays there): refused 422
`carveout_too_old` (`minimumVersion`) below `UPLOAD_CARVEOUT_MIN_VERSION`
for `carveout.version` or the record's `carveoutVersion`/`cutId`, checked
for the workspace's names, credentials and plain paths, stored by hash, and
imported by a `sandbox_import` run (origin `upload`). A passing
submission on such a version (or a generated one) comes back to the
maintainer's machine as its changed files (`get_submission_files`,
`GET …/sandboxes/submissions/:sid/files`, `submissions:write`, never a
hidden test) for `carveout patch --from`.
Approving,
publishing, confirming decisions and merging back have no tool. A request needs a
bearer `lnx_`, `lnxc_` or `lnxat_` token, else 401 with
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp…", scope="…"`.
`/mcp/contribute` (`CONTRIBUTOR_TOOLS`, `CONTRIBUTOR_MCP_INSTRUCTIONS`)
asks for `contributions:write` alone and serves `list_contributions`,
`get_contribution`, `get_project_files`, `preview_submission` (`?dryRun=1`),
`submit`, `list_my_submissions`, `get_my_submission`, `retry` and
`regrade` over `/api/v1/contributions…`; a workspace credential's call is
refused by the guard, as a contributor credential's on any other endpoint.
**Every tool wraps one public route**, called in-process with the caller's
own `Authorization`, so the guard, registry, scopes and `requireMembership`
decide; a refusal is a tool error carrying the API's `code`. Workspace
tools take the workspace from `GET /me/orgs`; contributor tools name a
version from `GET /contributions`. CloudFront routes `/mcp*` and
`/.well-known/*` to the API uncached (`infra/cloudfront.tf`).

## Public API conventions

What every `/api/v1` route a machine credential reaches shares, beside the
registry and scopes in [Auth](#auth):

- **Client floor** (`client-version.ts`): `Lunox-Client-Version:
<client>/<semver>` below its floor in `MIN_CLIENT_VERSIONS`
  (`duediligence=0.4.0,carveout=0.2.0`; empty, none; production's in
  `infra/ecs.tf`) is 426
  `{ error, code: "client_too_old", minimumVersion }`, before any
  credential is read, on `/api` and `/mcp*`. No header, another client or
  an unparsable version is served.
- **Idempotency** (`idempotency.ts`, `idempotency_key`): registry entries
  marked `idempotent` (the creates: bounties, webhooks, runs, builds,
  sandbox start and versions) and `POST .../tokens/cli` take
  `Idempotency-Key` from a `token`, `oauth` or `device` principal (not on
  contributor routes). The
  first 2xx or 4xx answer is kept 24 h per organization, route pattern and
  key, encrypted, and replayed with `Idempotent-Replayed: true`; another
  request under the key is 422 `idempotency_key_reused`, one still running
  409 `idempotency_key_in_use`; a 5xx or 429 frees the key.
- **Audit log** (`audit/trail.ts`, `audit_entry`): every POST, PUT, PATCH
  and DELETE by a `token`, `oauth`, `device` or `contributor` principal
  (a contributor's in the workspace whose version it acted on), refusals
  included, and a session's token, grant, webhook or contributor
  management: credential, client, person, method, route pattern, resource
  id, status, request id (`X-Request-Id`). Never a body, secret or query string.
  `GET /orgs/:orgId/audit` is session-only, owners and admins, cursor-paged.
  Kept 180 days (`AUDIT_RETENTION_DAYS`).
- **Connect links**: `GET .../github/connect` and `.../jira/connect`
  redirect a browser and answer `{ url }` when `Accept` puts
  `application/json` first; connecting stays a person's browser step.
- **Retention**: `BountyWatchdog`'s hourly `retention` passes prune audit
  entries past 180 days, expired idempotency keys and webhook deliveries
  past 30 days.
- **Model-token quota** (`packages/db/src/model-usage.ts`, `model_usage`,
  `apps/api/src/quota.ts`): every model reply the platform pays for (a
  worker agent's turn, `apps/worker/src/agent/metered.ts`; each sizing
  attempt, `BountyExecutor`) writes its input, output and cache tokens
  against the workspace and run. Once fewer than `MODEL_TOKENS_START_FLOOR`
  (250,000) of the workspace's `MONTHLY_MODEL_TOKENS_PER_ORG` (default
  60,000,000; rationale in `quota.ts`) are left this calendar month (UTC), a
  new `scope`, `fixtures`, `sandbox_build` or `sandbox_starter` run, or any
  sizing run but a trim, is refused 429
  `{ error, code: "quota_exceeded", kind: "model_tokens", used, limit, resetsAt }`
  with `Retry-After`. Never refused on a run's declared budget. Admission
  only: a run under way is never stopped.
- **Evaluator cap** (`packages/db/src/evaluator-usage.ts`,
  `evaluator_usage`): every evaluation job a run creates writes its seconds
  (rounded up) when torn down (`apps/worker/src/evaluation/metered.ts`).
  Once the month's seconds reach `MONTHLY_EVALUATOR_SECONDS_PER_ORG`
  (default 360,000), a new `sandbox_build`, `sandbox_starter`,
  `submission_grade` or `sandbox_import` run is refused 429
  `quota_exceeded` with `kind: "evaluator_seconds"`.
- **Contributor brakes** (`packages/db/src/grading-attempts.ts`,
  `grading_attempt`): queueing a grading run writes an attempt. An invited
  contributor's is refused 429 `rate_limited` (with `scope`, `limit`,
  `retryAt`, `retryable` and `Retry-After`) past 10 attempts per assignment
  (`GRADING_ATTEMPTS_PER_ASSIGNMENT_DAY`) or
  `CONTRIBUTOR_GRADING_RUNS_PER_ORG_DAY` (default 200) per workspace in a
  rolling day; the submission is kept. Dry runs never count. Every
  `Retry-After` is measured by the app's clock (`AppOptions.now`, set on
  the context as `clock`).
- **Usage**: `GET /orgs/:orgId/usage` reports the month as `modelTokens`,
  `evaluatorSeconds` (with jobs by kind) and `thisMonth` (grading attempts,
  contributors' share, uploads); the web app's Usage page shows them.

### Webhooks

`apps/api/src/webhooks/`, tables `webhook_endpoint` and `webhook_delivery`
(`packages/db/src/webhooks.ts`). Routes under `/orgs/:orgId/webhooks`, owners
and admins, in the registry (reads `workspace:read`, writes
`webhooks:write`): list, get, create (answers the `whsec_` signing secret
once), update, delete, `rotate-secret` (once), `deliveries`,
`deliveries/:deliveryId/redeliver`, `ping`. The secret is encrypted like
integration credentials.

- **Events** (`WEBHOOK_EVENT_TYPES`, `emitter.ts`): `run.finished` and
  `proposal.priced` (each proposal a sizing run made) and
  `sandbox.build.finished` from the run change channel; `sandbox.published`
  from the publish route; `writeback.failed` from `BountyDelivery`;
  `submission.graded` (verdict and counts, never a hidden name or scenario
  key) from the run change channel; `submission.merge_opened` from the merge
  route; `submission.ci` and `submission.merged` from merge-back's CI
  read-back. A body is `{ id, type, createdAt, organizationId, data }`,
  `data` ids and states only; the submission events' `data` is checked
  against `WEBHOOK_EVENT_DATA_SCHEMAS` before it is enqueued. An event's id is derived from what it is about and a delivery is
  unique per endpoint and event, so each API process hearing a change owes
  one delivery. A change lost to a restart is lost, as for pages.
- **Sender** (`sender.ts`): a loop in the API process claims due deliveries
  (leased, `FOR UPDATE SKIP LOCKED`), POSTs with
  `Lunox-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`,
  `Lunox-Event-Id`, `Lunox-Event-Type`, 10 s timeout. Only 2xx succeeds;
  eight attempts over about 23 h (`WEBHOOK_RETRY_DELAYS_MS`); 20 failed
  attempts in a row disable the endpoint with the reason, and enabling
  clears it.
- **SSRF guard** (`ssrf.ts`, `transport.ts`): https only (http to localhost
  only when `BETTER_AUTH_URL` is local), no credentials in the URL; every
  resolved address is checked in the socket's own lookup, so the address
  checked is the one connected to: private, loopback, link-local and
  metadata, CGNAT, multicast, reserved, documentation, and IPv4 inside IPv6
  by the IPv4 it carries. Redirects are not followed.

## Organizations

Better Auth's `organization` plugin owns `organization`, `member` and
`invitation` and every write to them under `/api/auth/organization/*`.
`packages/db/src/organizations.ts` covers the reads it lacks, mounted under
`/api/v1/orgs`.

- **Two names.** `organization.id` is permanent and referenced by anything
  durable; `slug` is the renameable public handle, as `user.username` is.
  Users and teams share one handle namespace in the `handle` registry table;
  triggers keep it in step, and a personal organization follows its owner's
  username on every rename.
- **Hooks in `auth.ts` close the plugin's gaps.** `beforeCreateOrganization`
  and `beforeUpdateOrganization` validate and lowercase the slug and repeat the
  "already taken" check case-insensitively, since the plugin checks the raw
  body before normalisation.
- **`session.activeOrganizationId` is a preference, never an authorisation
  input.** Organization-scoped routes take the id from the path and check the
  `member` table (`requireMembership`); a non-member gets 404.
- **Invitations are in-app.** No mail is sent; an invitation is a row the
  invitee finds on their account page, matched against their primary address.
  The server-only `addMember` endpoint is not used.
- **Every organization keeps at least one owner**; the plugin refuses the last
  one leaving, and the settings page disables those controls.
- **Every user has a personal organization**, created by the
  `user.create.after` hook (`kind = 'personal'`, sole owner, the user's
  handle). This is what lets ownable rows take one non-null `organization_id`.
  It cannot gain members or be deleted (`refusePersonal` guards in `auth.ts`)
  and goes with the user by cascade. **Nothing below the API boundary branches
  on `kind`**; only the workspace switcher, list and settings page do.

Open, cheap if needed: invitations match the primary address only (a
`beforeAcceptInvitation` hook over `EmailStore.list` would widen it); handles
are not reserved (`admin`, `api`, `o`, `u` are claimable). Deliberately not
built: teams, custom roles, an email transport, an avatar crop tool or
orphan sweeper.

## Avatars

Every user and team has a generated identicon (`packages/shared/src/identicon.ts`,
frozen) and may upload a picture over it; a personal organization wears its
owner's. An upload is re-encoded to a 256px WebP with no metadata and named
by its hash (`apps/api/src/avatars/image.ts`). `user.image` and
`organization.logo` hold only our own served paths, enforced by hooks in
`auth.ts`. Reads at `GET /api/avatars/:kind/:id/:hash.webp` are sessionless,
outside `/api/v1`, and cached for a year. A team's picture is owners' and
admins' to set.

## Web app

`apps/web/src/data/query.tsx` gives authenticated content a user-scoped
`ServerDataProvider`; TanStack Query owns server reads with keys that include
user and owner before resource ids. Queries do not retry or refetch on
focus; stored reads are fresh for 30 seconds; mutations invalidate resource
families. Forms, dialogs and URL selections stay local.
`navigation/location.ts` publishes the pathname/search/hash snapshot; `routes.ts`
defines every path and the legacy addresses it still lands. Feature clients in
`packages/client/src` share `transport.ts`; query hooks and the run observation
lifecycle live in the web app's `features/`.

**Home** (`Home.tsx`) shows one card per workspace with the counts `setup` on
`/api/v1/me/orgs` answers (`packages/db/src/workspace-setup.ts`); every count
links to the page it is made on, the bounties to `/bounties?workspace=<slug>`.
**Onboarding** (`Onboarding.tsx`, `/onboarding`)
is the getting-started checklist plus what no model call paid for: a board's
backlog scan once Jira is connected (`features/onboarding/BoardScan.tsx` over
`BacklogScan.tsx`) or a repository's x-ray from its snapshot (`RepoXray.tsx`).
`features/onboarding/setup.ts` decides the stage and `setupComplete`; until
every step is done the rail offers onboarding alone and `/` lands there, and
afterwards the rail drops it. Consent round trips return to the page that
started them (`WorkspaceNotices.tsx`). Sizing from onboarding waits for a
repository where GitHub is offered (`insights.ts`).

**Bounties** (`/bounties`) lists every workspace's bounties newest first from
`GET /api/v1/me/bounties`, which reads the caller's memberships and lists
across them (`BountyStore.listAcross`). A bounty opens in a panel
(`?peek=:workspace/:id`, read-only) or on its page (`/bounties/:workspace/:id`)
with three tabs, `?tab=scope|price|sandbox`. A new one is written at
`/bounties/new`. A sandbox version's files open at
`/sandboxes/:workspace/:versionId?path=`, outside the shell. A repository's
page is `/o/:slug/repositories/:repoId`; settings are `/o/:slug/settings`.

**Contributors** (`features/contributions/`) have pages under no
workspace: `/invite#<secret>` claims an invite (signed out, the secret
waits in session storage, never in the sign-in's callback), `/contributions`
lists their versions (also home for someone in no workspace, and a rail
item whenever there is one) with "Tokens for your editor or agent"
(`ContributorTokens.tsx`: `lnxc_` tokens, contributor-signed-in apps, the
`/mcp/contribute` command), and `/contributions/:vid` holds the download,
commands, the folder upload with its dry-run preview, and their verdicts.
A version's Sandbox tab invites and revokes them
(`features/sandbox/SandboxContributors.tsx`); its submissions name them.

**Developers** (`features/developers/DevelopersPage.tsx`,
`/o/:slug/developers[/tokens|apps|mcp|reference|usage]`) is the portal for
owners and admins; members see a notice. `/developers` opens on the
workspace in the rail and is rewritten to its address. A new token's secret
lives only in the tokens page's state until dismissed, never in the query
cache. Connected apps read a 404 from the grants list as not available. The
API reference is its own chunk, read from `GET /api/v1/openapi.json`; MCP
toolsets are restated in `features/developers/snippets.ts` and must follow
the API's `TOOLSETS`.

## API structure

`apps/api/src/http-context.ts` and `access.ts` hold request context and access
rules; `credentials.ts` admits each credential (see [Auth](#auth)). `pricing/start-run.ts`, `pricing/approve-proposal.ts` and
`sandbox/version-service.ts` take explicit owner, input and dependencies;
routes keep membership checks, parsing and HTTP mapping. `analysis/enqueue.ts`
shares queue and log cleanup. Provider wiring is in `server.ts`: Anthropic
first with DeepSeek as fallback when both are configured, else either alone.
`env.ts` lists every variable the API reads and `test/env-surface.test.ts`
pins the list.

## Bounties

### Vocabulary

| Term                 | What it is                                                             | Done when                                                  | Code                                                       |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| **Bounty**           | The whole record of one piece of work. Never the name of a step.       |                                                            | `bounty`                                                   |
| **Scope** (step 1)   | Its title and description. Versioned.                                  | An owner or admin approves the version it is at.           | `stages.scope`, `scopeApproved`, `bounty.approved_version` |
| **Price** (step 2)   | Its size and what that pays, with reasoning. Held by its **proposal**. | Its proposal is approved.                                  | `stages.price`, `bounty_proposal.status = 'approved'`      |
| **Sandbox** (step 3) | The task cut for contributors, as versions.                            | A version is published and the publication has not lapsed. | `stages.sandbox`, `isPublicationLive`                      |

A bounty's **status** is the last step done (`bountyStatus` in
`packages/core/src/stages.ts`): **New**, **Scoped**, **Priced** or **Live**.
The furthest step decides, so a Live bounty stays Live while its scope is
edited. A proposed, unapproved price is "price pending" beside the status.
**Draft** is only a sandbox's unpublished state. **Proposal** names the record
and its API (`/proposals/...`); the button reads "Price it".

### The model

**A bounty is the platform's own record: a proposal and a sandbox at least.**
`bounty_proposal.bounty_id` (one live at a time) specifies and prices it;
`sandbox.bounty_id` (exactly one) is where contributors do it. Jira, GitHub
and any later source enrich it; none is required. A deployment with a model
and no integrations sizes the bounties written in it and makes their
sandboxes.

**A GitHub issue is imported once** (`bounties/github-issue.ts`):
`POST .../bounties` with `{ source: { githubIssue } }` reads the issue of a
connected repository (`repository_not_connected` otherwise) through an
`issues`-scoped installation token; a missing issue or a pull request is
`issue_not_found`. The bounty takes the title, and the body with its labels
as the description, origin `github`, and keeps the URL in
`bounty.source_url`, unique per organization, so importing it again answers
that bounty (200). Nothing follows the issue afterwards.

**Jira enriches a bounty, never owns it.** A `jira_issue` row
(`jira_issue.bounty_id`) is the pointer half of an imported bounty. The first
run that reads an issue creates the bounty; every later read writes Jira's
text back (`refreshFromJira`, only when it differs). While the issue exists its
text is Jira's to change and the API refuses an edit (`jira_owned`); the stack
is the platform's. When Jira stops returning the issue, `removed_at` is set
and the bounty keeps its last text, edited and sized as stored. Losing a
board takes its pointers and the runs that read through it (and their
proposals) but not the bounties.

**Freshness is the bounty's.** `bountySpecHash` fingerprints title and
description; `packages/jira`'s `pricingSpecHash` is that function. A proposal
is current while the bounty still hashes to what it was priced from, read
live from Jira while it follows an issue (at most once a minute per bounty,
`apps/api/src/jira/recent.ts`) and as stored otherwise. The bounty row keeps
no issue type, priority or labels.

**Sources are synced into a bounty as context**, read only when asked
(`apps/api/src/bounties/context.ts`). `POST .../bounties/:id/context/jira/sync`
reads the issue's fields (`JiraClient.issueContext`; never a person or a
comment). Repositories are pinned, not synced: `GET .../context/github/commits`
lists each connected repository's built commits (`RepoSnapshotStore.built`,
`snapshotBuilt` in core) and `PUT .../context/github/commits` with
`{ commits: { repoId: snapshotId } }` reads every connected repository's
Markdown at its picked commit, else the one held, else its newest build.
Documents are chosen by `contextDocumentsAcross` in `packages/core/src/sources.ts`
and cut to one set of caps; a `documents` run's set is read before GitHub. Each
sync that finds something new is the source's next `bounty_context` version,
kept with the revision it was read at; the hash leaves revisions out, so an
issue edit or a commit that changes no document makes no version.
`GET .../context` says where each source stands: `unlinked`, `unsynced`,
`current`, `ahead` or `unavailable`. Any member may sync and pin; an approved
scope holds back neither.

The scope holds the latest version of each source (`heldContext` in
`apps/api/src/bounties/held-context.ts`), and that is what sizing and
generation are given (`renderSourceContext`). A proposal records the versions
it was sized with (`bounty_proposal.jira_context_version`,
`github_context_version`); a sandbox version freezes the context into its
approved task (schema version 3) and records versions on
`sandbox_version_source`. A step made with an older version than the scope
holds is behind on that source (`contextDrift`).

**Identity.** A bounty is identified by its id (`bty_`, older ones `tkt_`) and
shown by its title; one from Jira carries its issue key. There is no
per-organization number.

### Steps, versions and approval

Each step is versioned and none locks another. The scope's version is
`bounty.version`, kept in `bounty_version` on every title or description
change, from here or from Jira. A proposal's `revision` moves on every write
and is what `expectedRevision` checks; its `version` moves only when an
approval follows a change (`packages/db/src/proposal-version.ts`). A sandbox
version's is `sandbox_version.version`. Each step records the version of the
step before it: a proposal's scope version is the latest `bounty_version`
whose text hashes to its `spec_hash` (`scopeVersionOf`); a sandbox version's
price version is `sandbox_version_source.proposal_version`. A step built on an
earlier version than the step before is now at is behind (`stageDrift`),
answered as `stages` on the bounty's detail. `GET .../bounties/:id/versions`
lists scope versions.

`POST .../bounties/:id/approve` and `/unapprove` (owners and admins, against
`expectedRevision`) set or clear `bounty.approved_version`. While that is the
scope's version, title, description, stack and Jira link are held
(`scope_approved`); a Jira refresh that makes a new version leaves the
approval behind. A proposal is re-analyzed only while unapproved.

**Runs.** A `bounty` run sizes one bounty (`POST .../bounties/:id/propose`);
`reprice` and `respec` runs name their proposal's bounty. Those need a board
only when the bounty came from one, whose selection and pricing settings they
use. `backlog` and `issue` runs read a Jira board and import what they reach.
A bounty following an issue on a site that needs reconnecting fails
`reconnect` rather than sizing stale text. Approval posts back to Jira only
for a bounty still following an issue on a site with the write grant.

**Nothing is sized unasked.** Connecting or syncing a site registers boards
and starts no run. `GET .../jira/boards/:id/backlog-preview` is the selection
a `backlog` run would make, classified against
`packages/core/src/selection/categories.ts` from metadata alone, with no model
call. From it a person sizes one ticket (an `issue` run) or, told the cost,
the board (`POST .../jira/boards/:id/runs`, owners and admins).

**A board's scan is imported as bounties.** Every sync and registration hands
boards to `importBoards` (`apps/api/src/bounties/import.ts`) in the
background; `POST .../jira/boards/:id/import` does one board on request, or
one issue with `issueId` found through `GET .../jira/boards/:id/search`. Each
ticket the scan puts in a category, up to `IMPORT_LIMIT`, becomes a bounty
with its scope, a Jira context version with no `synced_by`, and
`bounty.categories`; no proposal, sandbox or model call. Any member may import.

**A board has no page.** Its view is `/bounties?board=<workspace>/<boardId>`.
The list filters by `category` (`uncategorized` for none), `board` or
`source=lunox`, `status` and `workspace` (one organization id; the page takes
its slug); `GET /api/v1/me/bounties`, `.../bounties`,
`GET /api/v1/me/bounty-categories` and `/me/bounty-statuses` take the same
filters. Status is decided in SQL as `bountyStatus` decides it
(`statusFilter` in `packages/db/src/bounties.ts`).

**Repositories.** A bounty names no repository and neither does a board. Its
stack is what is detected in every connected repository plus what the bounty
adds (`bounty.stack`), and sizing drafts each spec beside an outline of every
built repository at the commit the scope holds (`apps/api/src/sizing/outline.ts`,
neutral labels, one shared line cap). The draft names the repositories the work
touches, recorded on `bounty_proposal.repositories` with the snapshot each was
outlined at; a re-price says them again and a spec change keeps them. With one
repository outlined, a draft naming none still touches it
(`touchedRepositories` in `apps/api/src/pricing/executor.ts`).

## Sandboxes

**One per bounty, three faces.** `sandbox.bounty_id` is unique and required;
a bounty with a sandbox cannot be removed. The private face is
`sandbox_source` and `sandbox_version_source` (source repository, alias
table, approved task, hidden tests); the public face is `sandbox` and
`sandbox_version` (the aliased copy contributors work in); the protected face
is `submission` (a contributor's patch, pinned to a frozen version, run with
both suites). `submissionVerdict` in `packages/core/src/sandbox/submission.ts`
requires every test in both suites and at least one hidden test to pass; only
counts are kept. `gradingTree` in `grading.ts` builds what a submission is run
on: the version's files with only editable paths and new TypeScript files
beside them taken, everything else refused with reasons, and `GRADING_COMMANDS`
run without `npm run`. Its `taskCodeProblems` is an advisory lint, not a
boundary: a text match refuses the plain ways task code could reach the mocks,
the test run or `tests/private`, and misses others. Grading isolates task code
by job (`EvaluationJob.seal`, `apps/worker/src/evaluation/hidden-runner.ts`):
after the build and before any task code runs, every hidden test leaves the
tree; each then runs in its own process from a fresh copy of that sealed tree
holding it alone, read into memory and deleted by the platform's runner before
task code loads, its outcome read from outside. Residual: what a test hands
task code (a function's source, a stack's line numbers), `node:inspector` or
`/proc/self/mem` past the lint, and Vitest hidden tests, which stay on disk.

**Merge-back (gate 3).** Grading a version sliced from a repository runs on
its snapshot (`snapshotFits`), and a pass is carried back to the
repository's names at the sliced commit by `reverseSubmission`
(`packages/core/src/sandbox/carry.ts`, carveout's; under the renaming the
build manifest's `engines.carveout` names, `ALIASES_V1` without it): kept lines are the original's byte
for byte, added lines are renamed and refused unless they map back, and an
added import of the harness is refused. The result is the grading run's
`private/merge-patch.json`; one that cannot be carried is the verdict
`refused`. Before the patch is kept, the run builds and tests the version in
the repository's names in a second job, both suites (`repositoryTree` in
`apps/worker/src/tools/submission-grade.ts`, `submission_grade@4`; passes
only); a pass that fails there stays `passed` with `carryBack: "failed"`
and no merge patch, and merge answers 409 `carry_failed`. So does one whose
carry renames a word the contributor wrote by a pair learned from part of a
text rule (`carriedWordHazards`, `packages/core/src/sandbox/carried-words.ts`;
checked before the second job), and one whose carry is refused for the
carry's own limit, not the contributor's (`carryLimitOf`,
`packages/core/src/sandbox/carry-limits.ts`: a new file at a path the
repository holds outside the slice, carveout's stranded name after 0.3.1).
A version's carried tests
(below) go back to `tests/public/carried/<repository path>` there. Starter and
upload versions skip it: the platform holds no repository names for them.
The verdict is written in the run's fenced commit with its artifacts
(`RunSettlement` in `packages/db/src/analysis-runs.ts`), so a pass never
stands without its merge patch unless it is `carryBack: "failed"`.
`POST …/submissions/:sid/merge`, from a signed-in session only (a merge
patch that does not parse is 502 `merge_patch_invalid`, logged),
opens one pull request per submission (`submission_merge`) with
`PullRequestWriter` (`packages/github/src/pull-requests.ts`), whose token
`mergeBackWriter` narrows to the one repository and
`MERGE_BACK_PERMISSIONS`. It is idempotent: the row is claimed `pending`
on its unique key before GitHub is asked (a concurrent press gets 409
`merge_in_progress`, a failure releases the claim), the writer reuses a
`lunox/<sid>` branch whose head has the same tree and an open pull request
from it, a branch with other changes is 409 `branch_conflict`, and an
opened one answers 200 with the same body. Before it, the installation's
permissions are read from GitHub (`apps/api/src/github/merge-back.ts`);
missing ones are 409 `app_permissions_missing` with `missing` and
`acceptUrl`, which `GET …/versions/:vid/merge-back` (session only) also
answers so the version page (`SandboxSubmissions.tsx`) disables the button
with the reason. The body `{ "when": "ci_passes" }` (also on one already
open) asks the platform to merge it once the repository's CI passes.
**CI read-back** (`apps/api/src/github/merge-ci.ts`): each open merge-back
pull request (`submission_merge.repo_id`, `pull_request_state`, `ci_*`,
`merged_*`, `merge_error`) is read back on GitHub's `check_suite`,
`check_run`, `status` and `pull_request` deliveries (`webhook.ts`, after
the answer) and by the reconcile sweep for rows not read in four minutes
(fourteen days after opening): its head's check runs and statuses
(`summarizeCi`: `failing`, `pending`, `passing`, `none` after ten minutes
with no checks, `unknown` without `checks:read`/`statuses:read`, which
never block opening and readiness names in `ciMissing`). On `passing` with
`ci_passes` it is merged squashed at the head read
(`PullRequestWriter.merge`); never on any other state; GitHub's refusal
(branch protection, review) is kept in `merge_error` and it stays open.
Starter and upload versions have no pull request: `GET
…/submissions/:sid/files` (and `/files/archive`, a `.zip`) answers a pass's
changed files, a starter's in the version's own names (its project is
generated already renamed, so nothing is reversed). The pull request
carries no hidden suite.

**CI judge.** `POST /api/judge` and `GET /api/judge/:id?workspace=`
(`apps/api/src/judge/`), outside `/api/v1` as the webhook is, take a pull
request's files from its own Actions run (`duediligence ci --platform`,
duediligence's `action.yml`). The run's GitHub OIDC token, for the
platform's origin (`BETTER_AUTH_URL`), is verified against GitHub's
published keys (`oidc.ts`); it is admitted only when its `repository_id`
is the repository the published version was sliced from, through a healthy
installation, and any other refusal reads as not found. Grading takes
`names: "repository"`: the files are carried forward with `forwardChange`
on the snapshot, only editable files and files new to the repository are
judged, and nothing is carried back. The same files again queue a
submission that has no run (`run_limit` is `retryable`). The job's own exit
is the check; no `checks` permission is needed.

**Nobody picks the repository.** `POST .../sandboxes` takes `bountyId` and cuts
from the one repository the live proposal says the work touches
(`bounty_proposal.repositories`). None or several makes a sandbox with no
source, whose versions are generated. `PUT .../sandboxes/:id/source` links one
later, once (`no_touched_repository`, `source_linked`). `POST .../sandboxes/start`
(owners and admins) makes the sandbox and begins its first version in one
request: sliced when it has a repository, generated when not.

**Without a repository, a version is generated.** `POST .../sandboxes/:id/starter`
snapshots the task from the bounty and its approved proposal (`task_not_ready`
otherwise) and queues a `sandbox_starter` run, whose agent writes a starter in
the bounty's vocabulary with a name table applied under the inverse proof
(`packages/core/src/sandbox/starter.ts`). The same agent writes its hidden
tests, so an accepted set is calibrated by a reference agent that never
sees them (`calibration.ts`, `hiddenTests: "withheld"`): tests the reference
fails are dropped, none expected to fail left holds the build, recorded in
`build-transform.json` as a sliced build's. The contract is Node and
TypeScript; another runtime is `stack_unsupported`. A generated version's
transform, build and replay are refused (`generated_version`); it changes by
generating a new version. Such runs read no snapshot, so
`analysis_run.organization_id` owns every run.

**With a repository, a version is sliced from its sizing.** The slice is the
complexity profile of the approved proposal's spec revision in the sandbox's
repository (`bounty_profile`), scoped and sliced by the profiler. `GET
.../sandboxes/:id/slice` reports `none`, `queued`, `scoping`, `slicing`,
`awaiting_approval`, `ready`, `failed` or `unavailable` (`no_source`,
`task_not_ready`, `unconfigured`). A slice wider than `AUTO_SLICE_LIMITS`
(`packages/core/src/slice/scope.ts`: a directory entry point, over 40 files
or depth over 3) is measured and priced, but awaits approval, with its
request and files shown, before anything is cut or prepared from it; a
profile measured `ready` from one before approvals existed is held the same
(`holdSlice`, which never holds one approved since it was read).
`POST .../:id/slice/approve` (owners and admins) names exactly that run and
request (`slice_changed`, `slice_not_awaiting_approval`, `published`),
records the first approver, makes the profile `ready` and asks for a cut as
that approver; asked again for the same approved run, by anyone, it asks for
the cut again as the first approver.
`POST .../sandboxes/:id/slice` asks for a profile (202) or, once ready, cuts
a draft as `POST .../:id/versions` does and queues its build
(201). A 202 remembers the request on `sandbox_source.cut_requested_*`, and
`apps/api/src/sandbox/cutter.ts` cuts it once the profile settles. A live
publication refuses slicing (`published`). A sliced draft starts with no
fixtures, hidden tests or pseudonyms, and no model stands between its cut and
its first baseline. Fixtures come only from a `fixtures` run attached to the
draft, else it builds with none (recording mocks, the default walkthrough). The name
table is drafted by rule (`packages/core/src/sandbox/pseudonyms.ts`: workspace
package imports become relative paths, vocabulary terms become placeholders),
and only a draft the build's check refuses goes to the pseudonyms agent
(`apps/worker/src/tools/pseudonyms.ts`), which starts from it. The check
also refuses an import rule whose relative path reaches no generated file
(`unresolvedImportRules`), and a mock runtime is named by its public path, so
a renamed cut module keeps its fixtures. Only the
vocabulary is renamed by rule; what else says whose code it is goes to the
agent as hints (below).
Hidden tests are written by an agent beside the first
baseline (`hidden-tests.ts`), its first prompt quoting the project and a
test file per scenario drafted by rule (`hiddenTestScaffold`: the path, the
imports that resolve from it, the steps as comments); it may
submit the set its last passing run ran without writing it again. A
reference agent then calibrates that set on duediligence's rule
(`calibration.ts`, `duediligence/api` pinned exactly): only tests a
reference implementation passes stand. The repository's own tests
of the slice are carried as read-only public tests under
`tests/public/carried/` when the slice asked for them
(`SliceParams.carryTests`, set on new slices; `POST
…/repositories/:id/slices` and MCP `plan_slice` take it, default true) and
they pass twice on the untouched project in a job before the baseline
(`packages/core/src/sandbox/carried-tests.ts`; `node:test` only, imports
inside the slice or its stubs, `carriedTestLimits`); the rest are dropped
with why in the build manifest's `carriedTests`, owners only. `POST
…/sandboxes/:id/slice` `{ "carryTests": false }` builds the draft without
them, and its later builds keep that (build param `carryTests: false`);
the web's Slice section has the checkbox and the counts. The build
reads the slice, the preparation and the repository's names at once, and
shows its preview while the baseline runs. Agents run
at the effort their work needs (`AgentEffort`): `medium` where a
deterministic check decides (scope, hidden tests, pseudonyms). Each set
is kept only once its check passes, and settles on the draft when the run
commits (`recordBuildOutput`). Every build scans the
public files for the workspace's names (`packages/core/src/sandbox/vocabulary.ts`,
passed as the build's and starter's `vocabulary`; the organization's name,
handle and repository owner by their distinctive words too, and the scope, or
multi-word name, of each workspace or private-registry package the slice imports) and blocks `vocabulary_leaked`,
and for credentials (`packages/core/src/sandbox/secrets.ts`) and blocks
`secret_found`, naming file, line and rule, never the value. Every build
also scans beyond the vocabulary (`packages/core/src/sandbox/disclosure.ts`
`scanDisclosure`: addresses, URLs and hosts outside a public allow-list, IPs,
copyright and author lines, issue keys of the workspace's Jira boards
(`ticketKeys` param), chat links, `TODO(name)`; text the table wrote is
public). Generated text (title, summary, spec, decisions, stub and
walkthrough comments) is redacted; copied source is not rewritten, so its
findings are pseudonyms-agent hints. The draft's `disclosureAcknowledgements`
(`PUT .../versions/:vid/disclosure-acknowledgements`, owners and admins,
session only, each entry with `by`/`at`) settle the rest where the gate's
`acknowledgedAt` says. Sliced (`build`): the list is in the transform (its
build redacts and hints by it), what it leaves blocks `disclosure_findings`,
and a change rebuilds. Starter and upload (`publish`): the build reads no
list, so its files never depend on it, and records every finding (up to
`DISCLOSURE_FINDINGS_EVALUATED`) in a `pending_acknowledgement` gate that
keeps the build ready; the PUT moves neither transform nor evidence, and
publication checks the list then (`gatesOf`, `openDisclosureFindings`). A
starter's check still refuses any candidate with a finding (the agent
renames it); an import records them after the baseline. The round trip also refuses a host or
address text rule that changes words one for one (`carryHazards`):
merge-back would learn those words; grading withholds the rest
(`carriedWordHazards`).

**Slice checks.** A slice (`apps/worker/src/tools/slice.ts`) stubs each cut
module from its declarations, the repository's own packages included,
resolved to their source (`workspaceModuleResolver`). The worker fetches the
published types of the public packages a slice reads
(`npmPackageTypes` from `carveout/extract`: the lockfile's versions,
install scripts off, the public registry only, cached by package set); when
it cannot, those packages are untyped. The fixture compile blocks only on
errors the stubs add: one the source shares under untyped packages is kept as
`compilation.untypedPackageErrors`, for the sandbox build to check against the
packages it installs, whose own types win over the generated declarations.

**Preparation.** Once a bounty's profile is ready and its price approved, and
the bounty has no sandbox, `apps/api/src/sandbox/preparer.ts` starts its
sandbox as a Sandbox click would, as the price's approver: made, cut and
built, hidden tests included, so a later click finds it there
(`bounty_has_sandbox`, which the page reads as done). What the cut would
refuse is refused before the sandbox is made (`cutRefusal`), so none is left
without a version; so are unconfirmed decisions (`decisionsRefusal`, also on
`POST …/sandboxes/start`), held with nothing made until a person confirms,
which prompts a pass. A held step, a bounty
touching no single repository, and a wide slice nobody approved are left for
a person, and not read again by a timer pass until a prompt or a change; a
build refused at the cap becomes a pending cut. Organizations are worked on
four at a time. Older profiles
name a `fixtures` run on `bounty_profile.prepared_run_id`, whose fixtures and
table a build still takes. `workspace_setting.prepare_sandboxes` turns it off (`GET`/`PATCH
.../settings`, owners and admins).

**Publishing.** `POST .../sandboxes/versions/:vid/publish` (owners and
admins) freezes the version and makes it `current_version_id` with status
`published`. It needs a passing build (`not_ready`), stands on the approval
its task was taken from (`price_not_approved`) and on its spec's confirmed
decisions (`decisions_unconfirmed`), and on the publication gates its build
recorded (`build-manifest.json` `gates`, read by `gatesOf` into
`freezeReadiness`): a failed no-change round trip is `round_trip_failed`
(with `problems`), disclosure findings `disclosure_failed` (with the
unacknowledged `findings`; for a `pending_acknowledgement` gate, against the
draft's list now, with `pendingAcknowledgement` and `unrecorded`), evidence of other
inputs `build_evidence_stale`, a rebuild meanwhile `version_changed`. A
blocked build (`ready: false`) answers its failing gate, else `not_ready`
with its `blockers`, before `build_evidence_stale`. A first
publication records the build run as `roundTripRunId` and `disclosureRunId`.
A draft built before the gates is `gates_unrecorded` until built again; a
version published before them republishes `grandfathered` (the response's
`gates`). The body names `expiresAt` (`expiry_past`); an expired publication
no longer holds the approval. `POST .../sandboxes/:id/unpublish` returns to
`draft`. No public repository is pushed.

**Files.** `GET .../sandboxes/versions/:vid/files` lists what the build run
wrote (`project/`, hidden tests under `private/`, the build's records) and
`.../files/content?path=` answers one as text, matched against the run's
artifact rows, never joined into a key; over `SANDBOX_FILE_TEXT_MAX_BYTES` or
not UTF-8 is `text: null`. Owners and admins only.

**Project download.** `GET …/versions/:vid/archive` (and HEAD) answers the
handout's public files as one `.zip` under `<sandboxId>-v<n>/`, with
`Content-Disposition`, a strong `ETag` (`projectSha256`) and
`private, no-cache`; `GET …/versions/:vid/handout/files?cursor=&maxBytes=`
pages the same files with contents (UTF-8 or base64) for agents
(`get_project_files`). Both build from the handout's list only and check
each file's size and sha256 before serving: a mismatch is 502
`project_mismatch`, never a partial body; over `PROJECT_ARCHIVE_MAX_BYTES`
is 409 `project_too_large`. The handout's access (owners and admins; drafts
too), or an invited contributor's own (below); the answers
(`apps/api/src/sandbox/handout.ts`, builder `project.ts`, writer `zip.ts`)
take no access decision.

**Contributors.** Before a marketplace, an owner or admin invites one
person outside the workspace to the current published version
(`apps/api/src/sandbox/contributors.ts`, store
`packages/db/src/contributors.ts`, tables `contributor_invite`,
`contributor_assignment`). `POST …/versions/:vid/invites`
(`sandboxes:write`; `not_published` otherwise) answers the `lnxinv_` secret
once, in `claimUrl` (`<app>/invite#<secret>`; only its SHA-256 is kept),
default 14 days, 1 claim; `GET …/versions/:vid/contributors`,
`POST …/invites/:id/revoke`, `POST …/contributors/:id/revoke` (session
writes audited). The person signs in and `POST /api/v1/invites/claim`
`{ token }` (session or contributor credential, 10 a person per 15 min per process; revoked,
expired, spent, unknown, or the version no longer live: one 404
`invite_unavailable`; a member: 409 `already_member`) makes an assignment,
never a membership. `/api/v1/contributions[/:vid[/handout|/archive|/handout/files|/submissions[/:sid[/retry|/regrade]]]]`
sit outside `requireMembership`, in the registry with the contributor
audience (a session or a contributor credential, `contributions:write`):
each reads the caller's live assignment to `:vid` (owner = the
assignment's), else 404, so a revoke ends access at once. A contributor
reads the version's listing from its `sandbox-task.json` (title, summary
and tags redacted by every build), the handout (no build run) and its own
submissions (no run, carry-back, merge or contributor field); one
first submission per assignment (`already_submitted`), its one retry theirs
alone (an owner's retry is 409 `contributor_submission`), new work only
while the version is live (`not_open`). Owners' submission views carry
`contributor`. The same files are the same submission per person
(`submission_version_patch_unique`, nulls not distinct). Editors, agents
and CLIs act as a contributor with an `lnxc_` token or a contributor OAuth
grant ([Auth](#auth)); MCP at `/mcp/contribute`.

**Folder submissions.** `POST …/submissions/zip` and
`…/submissions/:sid/retry/zip`, a contributor's (session or contributor
credential; a binary body in the OpenAPI document) and an owner's (session
only), take the zipped project folder as the body (`application/zip`, at
most `SUBMISSION_ZIP_MAX_BYTES`; `apps/api/src/sandbox/folder-upload.ts`,
reader `unzip.ts`) and compare it with the handout's hashes
(`folderSubmission`, `packages/core/src/sandbox/folder.ts`): changed
editable files and new files grading takes are the submission; guide and
editor files (`isGuidePath`: guides, `.vscode/`, `.idea/`, the extension's
`.lunox/`) are ignored; `node_modules/`, `.git/`, OS files and build output
(`isBuildOutput`) are skipped unread. Anything grading would refuse,
a changed read-only file, or a deleted editable file (the merge patch has
no deletions) is 422 `folder_refused` with `refused` by path before a
submission exists; `?dryRun=1` answers `{ preview }` and stores nothing.
Also `400 invalid_zip`/`unsafe_zip`, `413 zip_too_large`/`entry_too_large`,
`422 not_the_project`/`wrong_version`/`no_changes`/`too_many_entries`.
`files[]` submissions drop guide and editor files and build output the same
way before storing (`withoutGuideFiles`, `withoutBuildOutput`), exactly as
their `?dryRun=1` preview reports (`no_task_files` when nothing is left), so
no grading rule changed.

**Provenance.** A version's private source row records the slice's manifest
and contract hashes, the transform (alias rules, dependency choices, hidden
tests, fixtures) and a snapshot of the approved task; a transform change
clears the evidence gathered for the old one. A `sandbox_build` run generates
the project and runs its baseline through an evaluation provider; only
`EVALUATION_PROVIDER=local-process` runs builds, and it is not an isolation
boundary, so a worker with `NODE_ENV=production` refuses it. A repository a
sandbox is built from cannot be removed, because replay needs its snapshot.

## Pricing

`apps/api/src/pricing/executor.ts` coordinates drafting and sizing. The sizing
model sees the bounty text (never the outlines) and returns a whole size (`XS`
to `XL`, or `unsized`), never a price. `priceFor` in `packages/core/src/sizing.ts`
applies the organization's rate-card snapshot; a `+` size is the rounded
midpoint of adjacent prices.

Spec revisions add half steps for net scenario weight gained since the sized
draft (`packages/core/src/pricing/step.ts`): covered, light, moderate and heavy
default to 0, 1, 2 and 4 points, four per half step; trimming never goes below
the base and XL is the cap. A covered scenario (`weight.ts`) is behaviour
another scenario's code already has, so an exhaustive draft can still be XS.
Manual resize sets a new base at step zero; respec keeps base and settings
without a sizing call; reprice starts fresh on the current card.

**The rubric sizes a proposal from its draft, and again once its code is
measured** (`packages/core/src/pricing/rubric.ts`, `rubric-v4`): scenarios by weight plus
open questions, test cases, and code from the complexity profiles, minus
discounts for an analogous pattern, tests in the touched modules and CI; the
points per factor are `RUBRIC_POINTS` and the band edges sit beside them, and
the total is held at zero. The code is scored over every repository the work
touches, all of them or none (`unavailable`). Sizing
stores the assessment (`bounty_proposal.rubric`); when the profiler settles,
`RubricPricer` (`apps/api/src/pricing/rubric.ts`) re-scores and sets
`sized_by = 'rubric'` on a proposed proposal, unless a reviewer sized it or
the rubric is two whole sizes away (`rubricNeedsReview`).
`POST .../proposals/:id/rubric` restores the rubric's size over
a reviewer's resize. Contention is retried once per profile, then
`bounty_rubric_contended`.

**An approval is of the price that saw the code**
(`apps/api/src/pricing/approve-proposal.ts`). `POST .../proposals/:id/approve`
names `expectedRevision` and, from the web, `expectedPrice`: a price moved
since is 409 `price_changed` (`previous`, `current`); a moved revision at the
same price, or with no price named, is `proposal_changed`. While any of the
proposal's newest profiles is in flight it is 409 `profile_pending` (each
profile's repository and status); profiles settled under a still-pending
rubric are re-scored first (`rescore`). A spec with decisions (its
assumptions) is approved only once a person confirmed exactly those: else 409
`decisions_unconfirmed` with `confirmUrl` (`apps/api/src/pricing/decisions.ts`,
no waiver). A failed or absent profile approves the
spec's price, and the proposal and the response say `pricedFrom: "spec"`
(`pricedFromOf`). An approved price is frozen: nothing re-scores it (the
`RubricPricer` and respec skip it, a profile settled later for a sandbox's
slice included); a re-price unapproves it, and publishing needs a new approval.

## Jira

Connecting a site is a second Atlassian grant, apart from signing in, whose
consent asks `WRITE_SCOPES` (`packages/jira/src/oauth.ts`); a grant Atlassian
returns short of them comes back as `partial-scopes` and the site is still
connected. The flow and where each guard sits are in the header of
`apps/api/src/jira/routes.ts`. A connection that can no longer be read
answers `reconnect` until someone reconnects it. Tokens live encrypted in
`jira_connection` (`packages/db/src/cipher.ts`, with `key_id` beside each
value for rotation) and are refreshed by `apps/api/src/jira/credential.ts`,
the one file that knows both the store and OAuth. Requests are bounded by
`packages/jira/src/transport.ts`; reads retry within a deadline, writes
dispatch once.

## GitHub

One GitHub App, used two ways; the sign-in OAuth app is separate.

- **Installation tokens** do everything unattended, minted from the App's key
  (`packages/github/src/installation-tokens.ts`), cached in memory and never
  stored. `installationClient` in `apps/api/src/github/credential.ts` narrows
  every token to its call: `discovery` (`metadata: read`), `repository`
  (one repository, `contents: read`) or `issues` (one repository,
  `issues: read`, for an issue import). A mint refused with 422 marks the
  repository `gone`.
- **The user-to-server half** runs the connect flow. The grant in
  `github_grant` is encrypted like Jira's tokens and lives as long as the
  membership (a trigger on `member` drops it).

**The callback's `installation_id` is untrusted.** An installation is linked
only when it is in the person's own installation list, and
`apps/api/src/github/authority.ts` checks again: a personal account's must be
their own, an organization's must cover no repository they cannot read. That
check is made once, at link time. `github_connection.installation_id` is
unique, so another organization's attempt is `claimed`. The flow starts at
the OAuth authorize URL, not the install page, so reconnecting an existing
installation does not strand the person. Both connect flows sign `state` with
one secret and a `purpose` (`apps/api/src/connect-state.ts`).

**Repositories are pointers.** A `github_repo` row is GitHub's numeric id, a
name and the default branch's head. The webhook (`POST /api/github/webhook`,
signature over raw bytes, writes applied before the 2xx) and a reconcile sweep
every five minutes for repositories not read in fifteen (`If-None-Match`) keep
it current; a push moves the head only when `pushed_at` is not older than the
one recorded. Only `register` and `revive` bring a `gone` repository back. The
sweep tells the App's failures (a 401 to the JWT stops it) from an
installation's (a rate limit skips it; a gone installation sets
`uninstalled_at`).

**Every head is snapshotted** (`apps/api/src/github/snapshot.ts`), once per
`(repository, commit)`: the recursive tree and language totals, written
gzipped to `trees/<repoId>/<sha>/<objectId>.json.gz`, `TreeFacts` from
`packages/core/src/repo/tree.ts`, and a `repo_snapshot` row. Work is queued
off the request path and retried by the next sweep. The newest 20
unreferenced snapshots per repository are kept, plus any a proposal was
drafted beside. Snapshots need object storage; without a bucket the
routes answer 503. Other branches are snapshotted when pulled
(`GET .../repositories/:id/branches`, `POST .../repositories/:id/snapshots`
with `{ branch }`); only the default branch redetects the stack.

**The stack is detected beside the snapshot** (`apps/api/src/github/stack.ts`):
up to 30 manifests from the tree, read by object id with the narrowed token,
handed to `detectStack` (`packages/core/src/repo/stack.ts`); only the names
found are kept, on `github_repo.stack`, from the catalog in
`packages/core/src/stack.ts`. This and a bounty's document sync are the only
reads of file contents outside the worker.

## Analysis

**Five context builders** describe a snapshot, started from a repository's
page by an owner or admin and read by any member: `graphify`, `abstractions`,
`data_model`, `documents` and `brief` (`CONTEXT_BUILDERS` in
`packages/core/src/analysis.ts`; outputs in the worker README). A repository
has one context, the snapshot `github_repo.context_snapshot_id` names; "Build
all" (`POST .../repositories/:id/builds`) moves it, and the repositories
dialog builds a repository where it is registered
(`apps/web/src/features/analysis/useRepositoryBuilds.ts`). All runs are
`analysis_run` rows keyed by `(snapshot, tool, version, params)`, reached
through the repository's owner, with artifacts under `runs/<runId>/`. Graph
readers name `params.graphRunId` and wait for it; the API enqueues the graph
run first. A slice is cut for a bounty by the profiler and the sandbox flow,
never by hand from the repository page.

**Agents propose; deterministic code decides.** A `scope` run gives a model
read-only tools and proposes entry points and a budget; `check_scope` runs the
slice computation and an answer is recorded only when it agrees. With
succeeded `abstractions` and `data_model` runs it also reads module surfaces
and the data model, and its first prompt names the modules that share the
spec's words (`apps/worker/src/agent/scope-candidates.ts`). A `fixtures` run writes mocked behaviour and the
walkthrough, type-checked against the slice's stubs. Transcripts are never
stored. Agent runs need `ANTHROPIC_API_KEY` and `AGENT_MODEL` on the worker;
without them they fail `agent_unavailable`.

**A sized bounty is profiled from the code it touches.** The proposal/spec
transaction inserts a pending `bounty_profile` per touched snapshot (unique
per proposal, revision and snapshot). `apps/api/src/pricing/profiler.ts`
moves them on `NOTIFY analysis_run_ended` and a 30-second sweep: graph run,
then `abstractions` and `data_model`, then a `scope` run naming the ones that
succeeded, then the slice the scope recorded, then `buildComplexityProfile`
(`packages/core/src/pricing/profile.ts`): `ready`, or `awaiting_approval`
with the profile when the slice is wider than `AUTO_SLICE_LIMITS`, which
the rubric reads as measured. The profile is evidence, not a price. A step at the organization's analysis cap waits for the next sweep;
the cap counts agent runs and builds apart. A failed run fails the profile for
that revision; a re-price asks again.

**Events.** Every change a page follows is sent on `run_changed`, passed to
the workspace's push channel (`GET /api/v1/orgs/:orgId/events`,
`apps/api/src/events.ts`); the web app refetches when told and keeps a slower
timer behind it. Waits are measured from the rows (`bounty_run.model_calls`,
`bounty_profile.transitions`, `analysis_run.timing`) into the `flow_wait`
views (`packages/db/src/schema/flows.ts`), an operator's SQL prompt.

## The extension

`apps/extension` (CommonJS bundle; only `extension.ts` imports `vscode`,
logic in `commands.ts`, `contribute.ts`, `workspace.ts`, `zip.ts`). Platform
address: user/application setting `sandboxFactory.platformUrl` (default
`https://platform.lunox.work`; workspace values ignored). Commands, category
**Lunox**:

| Command                                                                                     | Does                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in with a contributor token / Sign out                                                 | Pastes an `lnxc_` token (link to `/contributions#contributor-tokens`), checked with `GET /contributions`, kept in `SecretStorage` keyed by origin; never in settings or disk                    |
| Open contribution                                                                           | Lists contributions, downloads `…/archive`, unpacks it (zip-slip and symlink safe; non-empty folder only on confirm), writes `.lunox/contribution.json` (version, root, platform URL), opens it |
| Preview submission / Submit                                                                 | Zips the folder (skips `node_modules/`, `.git/`, `.lunox/`, build output), `…/submissions/zip?dryRun=1`, shows files/ignored/refused, confirms, then submits or the one retry                   |
| Grade again / Refresh submission status / Show submission                                   | Status bar polls `…/submissions/:sid` (grading, passed, `overfit: s3`, refused, errored with Grade again → `…/regrade`)                                                                         |
| Open project folder, Show task, Install dependencies, Run the walkthrough, Run public tests | Reads `sandbox-task.json` for display; runs core's fixed command table in a terminal, in a trusted workspace only                                                                               |

Device-flow sign-in is not built.

## Migration notes

Migrations are generated; these are the ones later readers ask about.

| Migration | Did                                                                               |
| --------- | --------------------------------------------------------------------------------- |
| 0015      | Gave every existing user a personal organization                                  |
| 0029–0030 | The shared `handle` registry                                                      |
| 0043–0045 | Made every `jira_issue` a bounty; renamed tickets to bounties, `tkt_` kept        |
| 0046      | Dropped issue type, priority and labels; spec hash v2 (hash without type)         |
| 0048      | Dropped `bounty.number` and `B-12` keys                                           |
| 0049      | `analysis_run.organization_id` for runs with no snapshot                          |
| 0050–0051 | Proposal `version` apart from `revision`; the rubric assessment                   |
| 0053–0054 | Scope versions in `bounty_version`; scope approval                                |
| 0056–0057 | `bounty_context` versions; `bounty.categories`                                    |
| 0059      | Dropped `bounty.repo_id` and `jira_board.source_repo_id`; `proposal.repositories` |
| 0065–0067 | Cut requests, `repo_snapshot.built_at`, sandbox preparation                       |
| 0073      | `api_token`, `device_code`, `session.device_client_id`                            |
