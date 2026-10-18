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

- **`packages/core` has zero dependencies.** It is bundled into a browser, a
  Node server and an extension host, and is the one publishable package.
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
enabled. The seven auth tables are bundled as `authSchema` in
`packages/db/src/auth-schema.ts`. Two naming rules fail at runtime, not
compile time, because the adapter resolves names by string: exported consts
are singular, column properties are camelCase.

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
- **`/api/v1` requires a session**; `/health`, `/version` and `/api/auth/*` do
  not. `createApp` without `auth` serves 503 on `/api/*`, so a deploy missing
  the auth environment fails closed.
- **A session says who is asking, not what they may read.** Every store
  method takes the owner first and puts it in the query. Another owner's id
  returns 404, not 403, so ids cannot be enumerated.
- `account` has a unique `(provider_id, account_id)`; Better Auth throws on a
  collision rather than tolerating one.

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

## API structure

`apps/api/src/http-context.ts` and `access.ts` hold request context and access
rules. `pricing/start-run.ts`, `pricing/approve-proposal.ts` and
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
outlined at; a re-price says them again and a spec change keeps them.

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
run without `npm run`. No route takes a submission yet.

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
(`packages/core/src/sandbox/starter.ts`). The contract is Node and
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
profile measured `ready` from one before approvals existed is held the same.
`POST .../:id/slice/approve` (owners and admins) names exactly that run and
request (`slice_changed`, `slice_not_awaiting_approval`, `published`),
records the approver, makes the profile `ready` and asks for a cut as the
approver; asked again for the same approved run, it asks for the cut again.
`POST .../sandboxes/:id/slice` asks for a profile (202) or, once ready, cuts
a draft as `POST .../:id/versions` does and queues its build
(201). A 202 remembers the request on `sandbox_source.cut_requested_*`, and
`apps/api/src/sandbox/cutter.ts` cuts it once the profile settles. A live
publication refuses slicing (`published`). A sliced draft starts with no
fixtures, hidden tests or pseudonyms; a build writes each it lacks with an
agent (`apps/worker/src/tools/fixtures.ts`, `hidden-tests.ts`,
`pseudonyms.ts`), keeps a set only once its check passes, and settles them on
the draft when the run commits (`recordBuildOutput`). Every build scans the
public files for the workspace's names (`packages/core/src/sandbox/vocabulary.ts`,
passed as the build's and starter's `vocabulary`; the organization's name,
handle and repository owner by their distinctive words too) and blocks `vocabulary_leaked`,
and for credentials (`packages/core/src/sandbox/secrets.ts`) and blocks
`secret_found`, naming file, line and rule, never the value.

**Preparation.** Once a bounty's profile is ready and its price approved,
`apps/api/src/sandbox/preparer.ts` queues a `fixtures` run that also writes the
name table, named on `bounty_profile.prepared_run_id`, so the first cut builds
with them; a wide slice nobody approved is not prepared.
`workspace_setting.prepare_sandboxes` turns it off (`GET`/`PATCH
.../settings`, owners and admins).

**Publishing.** `POST .../sandboxes/versions/:vid/publish` (owners and
admins) freezes the version and makes it `current_version_id` with status
`published`. It needs a passing build (`not_ready`) and stands on the approval
its task was taken from (`price_not_approved`). The body names `expiresAt`
(`expiry_past`); an expired publication no longer holds the approval.
`POST .../sandboxes/:id/unpublish` returns to `draft`. No public repository
is pushed and the round-trip and disclosure gates `freezeReadiness` names are
not run.

**Files.** `GET .../sandboxes/versions/:vid/files` lists what the build run
wrote (`project/`, hidden tests under `private/`, the build's records) and
`.../files/content?path=` answers one as text, matched against the run's
artifact rows, never joined into a key; over `SANDBOX_FILE_TEXT_MAX_BYTES` or
not UTF-8 is `text: null`. Owners and admins only.

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

**The rubric sizes a proposal once its code is measured**
(`packages/core/src/pricing/rubric.ts`, `rubric-v4`): scenarios by weight plus
open questions, test cases, and code from the complexity profiles, minus
discounts for an analogous pattern, tests in the touched modules and CI; the
points per factor are `RUBRIC_POINTS` and the band edges sit beside them, and
the total is held at zero. The code is scored over every repository the work
touches, all of them or none (`unavailable`). Sizing
stores the assessment (`bounty_proposal.rubric`); when the profiler settles,
`RubricPricer` (`apps/api/src/pricing/rubric.ts`) re-scores and sets
`sized_by = 'rubric'` on a proposed proposal, unless a reviewer sized it or
the rubric is two whole sizes away (`rubricNeedsReview`). An approved proposal
is not touched. `POST .../proposals/:id/rubric` restores the rubric's size over
a reviewer's resize. Contention is retried once per profile, then
`bounty_rubric_contended`.

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
  every token to its call: `discovery` (`metadata: read`) or `repository`
  (one repository, `contents: read`). A mint refused with 422 marks the
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
and the data model. A `fixtures` run writes mocked behaviour and the
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

Reads `sandbox-task.json` from a clone for display and runs the fixed command
table from `packages/core` in VS Code terminals, only when invoked, in a
trusted workspace. The API address is a user or application setting; the
stored token is keyed by origin. Sign-in is not built: the client's
`getToken` callback is the seam.

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
