# Architecture

## Dependency direction

Dependencies point from apps into packages. Main paths below omit the
`packages/` prefix; apps also import `shared` and `core` directly.

```
apps/web, apps/extension → client → shared → core
apps/api, apps/worker    → db → core
apps/api                → jira → shared
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

`npm run lint:deps` (dependency-cruiser, part of `npm run lint`) enforces this
table plus two more rules: no unresolved imports and no runtime import cycles.
The rules are in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs); change
its `packageDependencies` allowlist together with this table. Cycles that pass
through a type-only import are allowed. The one accepted runtime cycle, between
the auth and organization schema modules, is recorded in
`.dependency-cruiser-known-violations.json`; do not add to that file to get a
new cycle past CI.

Three of these are load-bearing:

- **`packages/core` has zero dependencies.** It is bundled into a browser, a
  Node server, and an extension host, and is the one publishable package.
- **`packages/client` stays platform-neutral.** `fetch` only.
  [`packages/client/tsconfig.json`](../packages/client/tsconfig.json) sets
  `types: []`, so a `node:*` import fails to compile rather than breaking the
  extension bundle at runtime. `lib` includes `DOM` only for the web-standard
  `fetch`/`Headers`/`RequestInit` types.
- **Only `apps/extension` may import `vscode`.** That module exists only in the
  extension host; confining it is what lets the rest of the extension's logic
  live in shared packages.

`packages/db` sits beside `shared`: it depends on `core` and nothing else in the
repo. Both `apps/api` and `apps/worker` import it.

## Domain rules live in `packages/core`

[`packages/core`](../packages/core/src/index.ts) owns the shared domain rules:

| Area                                              | Source under `packages/core/src/`     |
| ------------------------------------------------- | ------------------------------------- |
| Public handles and bounty text                    | `handle.ts`, `bounty.ts`              |
| Bounty selection and pricing                      | `selection/`, `pricing/`, `bounty.ts` |
| Repository facts and slices                       | `repo/`, `analysis.ts`, `slice/`      |
| Sandbox provenance, generation, and task contract | `sandbox/`                            |

For handles, `apps/api` calls `normalizeHandle()` before
storing one and maps the refusal to a 400; `apps/web` calls `isValidHandle()`
and `toHandleStem()` in the rename forms.

It is a genuine domain rule rather than a wire concern, because users and
organizations draw handles from **one namespace** — a personal organization
takes its owner's handle — so what counts as valid has to be decided once.

`packages/shared` refines core's rules in `handleSchema` rather than restating
them, so a change to the rules cannot leave the two disagreeing.

## Browser state and application services

Better Auth owns the session and its organization writes. Authenticated web
content gets a user-scoped `ServerDataProvider` in `apps/web/src/data/query.tsx`.
TanStack Query owns memberships, invitations, integration lists, repositories,
members, account resources, bounties, pricing, proposal details/specs and analysis
resources. Keys include user and owner before resource identifiers, filters and
pages. Account changes recreate the cache; obsolete reads receive cancellation.
Queries do not retry automatically, refetch on focus or reconnect. Stored reads
are fresh for 30 seconds; intentional live Jira checks and run observation are
explicit. Mutations invalidate affected resource families, and infinite lists
retain the pages already opened when refreshed. Forms, dialogs, workflow inputs
and URL selections remain local.

`navigation/location.ts` publishes a stable pathname/search/hash snapshot for
browser history and application push/replace. URL-owned workspaces are resolved
from memberships before rendering owner-scoped content. Core's `roles.ts` parses
held role combinations; response schemas accept held role strings while role
assignment inputs keep their single-role allowlist.

Feature clients in `packages/client/src` share `transport.ts`, validate shared
success envelopes and preserve status, reason codes and conflict payloads.
Reads accept abort signals, including body consumption. Proposal titles use a
separate incremental NDJSON path. Query hooks and the observation lifecycle live
in the web app. Observation requests do not overlap, stop on terminal results
or tracking errors, and offer deliberate retry. Rate-card autosave serializes
writes and retains the latest queued draft, revision conflicts and failed edits.
Its controller is in `features/pricing/useRateCardAutosave.ts`; proposal lists,
categories, peeks, search, titles and sizing progress are in `features/bounties`.

API context and access rules live in `http-context.ts` and `access.ts`.
`bounty/start-run.ts`, `bounty/approve-proposal.ts` and
`sandbox/version-service.ts` take explicit owner/input/dependencies; routes keep
membership checks, request parsing and HTTP mapping. `analysis/enqueue.ts` shares
queue/log cleanup while callers retain interactive or profiler capacity policy.
Database transaction types are inferred from Drizzle; transaction-only helpers
state that requirement. Worker slice/build/fixtures share `tools/compiler-config.ts`
for resolved compiler options and raw JSON-compatible configuration. The resolver
separates active recursion from cached inherited configurations.

Shared slice artifact schemas validate supported version 1 shapes after consumers
verify original-byte hashes. Unsupported versions and malformed nested data use
the existing artifact-unavailable outcomes. Jira's `transport.ts` bounds headers,
bodies, OAuth and credential refresh, composes cancellation and aborts retry
waits. GET retries remain bounded; writes dispatch once. Shared refresh owns its
own deadline and persists rotated tokens before use, independent of one waiter's
cancellation.

## TypeScript configuration

[`tooling/tsconfig`](../tooling/tsconfig) holds the strictness contract in
`base.json`. Every workspace extends one of four variants:

| Config           | For                    | Notable departure                         |
| ---------------- | ---------------------- | ----------------------------------------- |
| `base.json`      | platform-neutral code  | —                                         |
| `node.json`      | API and Node libraries | adds `@types/node`                        |
| `react.json`     | the web app            | `moduleResolution: Bundler`, DOM libs     |
| `extension.json` | the VS Code extension  | **CommonJS** — the host does not load ESM |

Extend these rather than copying compiler options. Path settings (`rootDir`,
`outDir`, `include`) stay in the extending config.

Import extensions follow the resolution mode. `NodeNext` (`core`, `shared`,
`client`, `db`, `api`, `worker`) writes `from "./store.js"` for `store.ts`;
`web` (`Bundler`) writes `from "./tree"`. `extension` is bundled under
`Bundler` but its tests compile under `NodeNext`, so it writes the `.js` form,
which `Bundler` resolves too. A file moved between them needs its imports
adjusted.

## The database layer

[`packages/db`](../packages/db) holds the Drizzle schema, migrations, the
owner-scoped stores, and an S3 object store.

The store contracts and `NotFoundError` live in this package, not in
`apps/api`, because a package may not import an app.
[`packages/db/src/index.ts`](../packages/db/src/index.ts) exports them for callers.

Tests use fake stores and database fixtures. The server requires `DATABASE_URL`
and has no in-memory fallback.

Object storage is SeaweedFS' S3 gateway locally and an S3 bucket in
production, through one code path: only the plain object calls are used, and
both answer those the same way. `S3_BUCKET` switches it on; locally the
endpoint and a key pair point at SeaweedFS, in production neither is set, so
the SDK talks to AWS with the task role. The differences that do exist, and
where each is handled:

- `forcePathStyle` is on, because a self-hosted gateway has no per-bucket DNS.
  AWS accepts it too.
- SeaweedFS creates a bucket on first write; S3 returns `NoSuchBucket`.
  Terraform creates the production bucket (`infra/s3.tf`).
- S3 answers a missing key with 403 rather than 404 unless the caller may
  `s3:ListBucket`. The task role has it (`infra/iam.tf`); without it every
  never-uploaded avatar would be a 500.
- SeaweedFS as run in compose does not check credentials at all. Local
  development proves nothing about IAM; the production grant is its own check.

## Avatars

Every user and team has a generated identicon
(`packages/shared/src/identicon.ts`, frozen) and may upload a picture over it.
A personal organization has no picture of its own: it wears its owner's face
everywhere, so the only way to change it is on the account page.

**Uploads are re-encoded, never stored as sent.** `apps/api/src/avatars/image.ts`
sniffs the first bytes (PNG, JPEG, WebP or GIF only, so libvips never parses
SVG or anything else), refuses a canvas over 40 megapixels from its header, and
writes a 256px square WebP with no metadata. The object is named by the SHA-256
of those bytes.

**The picture columns hold our own served paths**, e.g.
`/api/avatars/user/<id>/<hash>.webp`, in `user.image` and `organization.logo`.
Both columns used to accept any string from a client — Better Auth's
`update-user` and the organization plugin's create and update — which is why
`logo` was once never rendered. Three hooks in `apps/api/src/auth.ts` now admit
only null or the owner's own avatar path, so both are safe to render. The
`update-user` guard is a _database_ hook on purpose: a request hook runs before
the bearer plugin resolves a session, sees none, and cannot tell the caller's
own path from another account's. A provider picture from signup stays until
the person replaces or removes it.

**Reads are sessionless and immutable.** `GET /api/avatars/:kind/:id/:hash.webp`
sits under `/api/` so every proxy forwards it, outside `/api/v1` so no session
is needed — member lists show other people's pictures, and the hash makes the
URL unguessable without the picture. It is cached for a year, at the browser
and at CloudFront, because a new picture is a new URL.

**Writes go where the session is.** The user upload writes through
`auth.api.updateUser`, whose response re-issues the session cookie, so the
five-minute cookie cache carries the new picture at once. A team's is written
through `OrganizationStore.setLogo` behind the membership guard, for owners
and admins. The replaced object is then deleted, best effort: a failure leaves
an orphan of a few kilobytes rather than failing a change that happened.

## Auth

Better Auth, configured in `apps/api/src/auth.ts` and mounted at `/api/auth/*`.
Google, GitHub and Atlassian only — `emailAndPassword` is never enabled, so
`/api/auth/sign-up/email` answers 400.

Its four core tables (`user`, `session`, `account`, `verification`) live in
`packages/db/src/schema.ts`, bundled as `authSchema` together with the
organization plugin's three (see [Organizations](#organizations)). **Two naming rules fail at
runtime rather than compile time**, because the adapter resolves both by string:
the exported consts are singular, and the column properties are camelCase even
though the columns are snake_case.

**Account linking is implicit, and `trustedProviders` is what makes that safe.**
Signing in with a provider whose verified email already belongs to an account
merges into it — only when the provider is trusted _and_ asserts
`email_verified`, and the existing account's address is verified. Adding a
provider to that list is a security decision: it must verify address ownership
before reporting an email. `apps/api/test/auth.test.ts` pins the list.

**Atlassian is trusted by assertion.** It reports no `email_verified` claim, so
`auth.ts` asserts one via `mapProfileToUser` and adds it to `trustedProviders`.
Untrusted is not a usable position — the same guard gates the authenticated
link route, so an untrusted Atlassian could not be connected from the account
page either. The accepted risk: whoever controls an Atlassian account bearing an
address can reach the account using it.

Atlassian also needs an explicit `read:me` scope — its default scopes return a
profile with no email — and sets `disableDefaultScope` to drop the site-scoped
`read:jira-user`. Requesting no product scopes lets the Atlassian app be
registered as resource-level (one selected site) rather than account-level.

**Two credentials, one session store:**

| Surface          | Carries                 | Why                                        |
| ---------------- | ----------------------- | ------------------------------------------ |
| `apps/web`       | httpOnly cookie         | The browser attaches it; JS cannot read it |
| `apps/extension` | `Authorization: Bearer` | An extension host has no cookie jar        |

The `bearer()` plugin enables the second, and the guard in `routes.ts` hands
Better Auth the whole header set rather than picking one. `packages/client`
sends `credentials: "include"` so the cookie survives a cross-subdomain hop.

`account` carries a unique constraint on `(provider_id, account_id)`. Better
Auth assumes that invariant rather than tolerating a breach —
`findAccountByKey` throws when two rows collide, breaking sign-in for both
users.

Everything under `/api/v1` requires a session; `/health` and `/api/auth/*` do
not. If `createApp` is given no `auth`, it serves 503 on `/api/*`, so a deploy
missing the auth environment fails closed.

**A session answers who is asking, not what they may read.** Every store method
takes the owner as its first argument and puts it in the query — `upsert`
records it, `remove` matches on both id and owner — so no call can read _or
write_ across owners. An id belonging to someone else returns 404, not 403, so
ids cannot be enumerated.

## Organizations

The second principal. Better Auth's `organization` plugin owns the tables
(`organization`, `member`, `invitation`) and every write to them, served under
`/api/auth/organization/*`. `packages/db/src/organizations.ts` covers the reads
it does not offer, and `apps/api/src/routes.ts` mounts them under
`/api/v1/orgs`.

**Two names, as a user has.** `organization.id` is permanent and is what
anything durable references; `organization.slug` is the public handle, unique
but renameable. The pair mirrors `user.id` and `user.username` deliberately, so
neither principal invites the mistake of storing a name as a key.

**The handle rules live in `packages/core`.** `packages/core/src/handle.ts` is
the single definition, shared by the profile store, the plugin hooks, the wire
schemas and both browser forms — the only package all four can import. Users
and organizations share **one** handle namespace, held in the `handle`
registry table (migrations 0029 and 0030): `dana` is either a person or a
team, never both. Triggers keep the registry in step with `user.username` and
team slugs, and a personal organization takes its owner's username and
follows it on every rename, so it never claims a handle of its own.
`slugOwner` and `setUsername` both ask the registry.

**The plugin leaves two gaps, closed by hooks in `auth.ts`.** It accepts any
non-empty string as a slug, so `beforeCreateOrganization` and
`beforeUpdateOrganization` validate and lowercase it. And its own "already
taken" check runs on the **raw** body before those hooks normalise it, so
`MyOrg` while `myorg` exists would pass it and fail on the unique constraint as
a 500; the hooks repeat the check case-insensitively, excluding the
organization's own id so a re-cased rename is not a collision.

**`session.activeOrganizationId` is a preference, never an authorisation
input.** One value is shared by every tab and by the extension's bearer
session, and the five-minute session cookie cache means a change in one lags in
another. Organization-scoped routes take the id from the path and check
membership against the `member` table; a non-member gets 404, not 403, exactly
as any other owner-scoped row does.

**Invitations are in-app.** `sendInvitationEmail` is left unset because this
codebase sends no mail: an invitation is a row the invitee finds on their
account page. It is addressed to their **primary** address, since that is what
Better Auth compares against the session on accept. The server-only `addMember`
endpoint is not used — joining changes what a session can reach, so the person
accepts it.

**Every organization keeps at least one owner.** The plugin refuses to let the
last one leave, be removed or be demoted; the settings page disables those
controls rather than letting the click fail.

**Every user has a personal organization.** It is created by the
`user.create.after` hook in `apps/api/src/auth.ts` — `kind = 'personal'`, a
sole `owner` member, and the user's own handle — and migration `0015` did the
same for everyone who predates the hook. This is what lets anything ownable
take a single non-null `organization_id` rather than a nullable
user/organization pair, which would need a `num_nonnulls(...) = 1` check
drizzle-kit cannot generate and would double every unique index and store path.

It cannot gain members or be deleted: the `refusePersonal` guards in `auth.ts`
cover the invitation, add-member and delete hooks, so "personal" stays a claim
about the organization rather than a label on a two-person one. It goes when
the user does, by the cascade on `personal_user_id`. Sharing means moving the
work to a team organization.

**Nothing below the API boundary branches on `kind`.** The stores take an
organization id and the guard checks membership, whichever kind it is. Only
surfaces distinguish them: the home screen groups connections by owner with
the personal one first, the organizations list labels and sorts it first, and
its settings page hides members, invitations and leaving.

### Open questions

Neither blocks anything; both are cheap if a need appears.

- **Invitations match the primary address only.** One sent to an address
  someone has proven but not made primary stays invisible to them. The fix is
  a `beforeAcceptInvitation` hook accepting any of the caller's proven
  addresses (`EmailStore.list`), not a schema change.
- **Handles are not reserved.** Words like `admin`, `api`, `o` and `u` can be
  claimed by a user or an organization. Once prefixed URLs (`/u/`, `/o/`)
  carry real pages, add a short reserved list to
  `packages/core/src/handle.ts`, applied to both principals.

### Deliberately not built

Teams; per-organization custom roles (`dynamicAccessControl`); an email
transport, at which point `sendInvitationEmail` is one function and the in-app
flow stays as the fallback; a crop tool, a sweeper for avatar objects orphaned
by a failed delete, and more than one avatar size (see [Avatars](#avatars)).

## Bounties

**A bounty is the platform's own record of a piece of work, and it is two
parts at least: its proposal and its sandbox.** The proposal specifies and
prices it (`bounty_proposal.bounty_id`, one live at a time); the sandbox is
where contributors do it (`sandbox.bounty_id`, exactly one). A bounty is
written here, or imported from Jira by a run, and either way it is one
`bounty` row, proposed, reviewed and cut into a sandbox the same way. Jira,
a GitHub repository and any source added later enrich a bounty with
context; none of them is required. A deployment with a model and no Jira
or GitHub configured sizes the bounties written in it, and makes their
sandboxes.

**Jira enriches a bounty rather than owning it.** A `jira_issue` row is the
pointer half of an imported bounty (`jira_issue.bounty_id`, one each): the
first run that reads an issue creates the bounty, and every read after —
a run, or opening one of its proposals — writes Jira's text back onto it
(`refreshFromJira`, only when it differs, so the revision does not move
for nothing). While the issue is there its text is Jira's to change, and
the API refuses an edit to it (`jira_owned`); its repository is the
platform's to set. When Jira stops returning the issue, the pointer is
marked `removed_at` and the bounty keeps the text it last had: it is then
sized, reviewed and edited as stored, like a bounty written here. If a
board's run finds the issue again, the pointer is restored and Jira's text
replaces the bounty's once more. Losing a board takes its pointers but not its
bounties; it does take the runs that read through it, and with them the
proposals those runs made (`bounty_run.board_id` and
`bounty_proposal.run_id` cascade).

**Freshness is the bounty's.** `bountySpecHash` in `packages/core`
fingerprints a bounty's title and description, and `packages/jira`'s
`pricingSpecHash` is that function, not a copy, so a proposal priced from
Jira's text and one priced from the stored copy compare. A proposal is
current while its bounty still hashes to what it was priced from: read live
from Jira while the bounty follows an issue, and as stored otherwise. A
bounty keeps no issue type, priority or labels; Jira's are read only to
choose which issues a board's run sizes, never stored on the bounty or shown
to the model.

**A bounty is identified by its id and shown by its title.** One from Jira
also carries its issue's key (`bounty.jira.key`, a proposal's `issueKey`);
one written here has no key, and those fields are null. There is no
per-organization number: `bounty.number` and its `B-12` keys were dropped in
migration 0048.

**Runs.** A `bounty` run sizes one bounty someone proposed
(`POST .../bounties/:id/propose`); `reprice` and `respec` runs name their
proposal's bounty too. Those three need a board only when the bounty came
from one, whose selection and pricing settings they then use; otherwise
the defaults. `backlog` and `issue` runs read a Jira board and import what
they reach. A bounty following its issue cannot be read while its site
needs reconnecting, and its run fails `reconnect` rather than sizing
stale text. Approval posts back to Jira only for a bounty still following
an issue on a site that holds the write grant.

**A proposal's revision and version.** `bounty_proposal.revision` moves on
every write and is what each change is checked against (`expectedRevision`),
what a write-back records and what a run starts from. `version` is the
number people see: it moves only when an approval follows a change.
`version_revision` holds the revision at which nothing has changed since
the current version. An approval writes its own revision there and a
withdrawal moves it on, so withdrawing and approving again keeps the version
and `versioned_at`. A resize, re-price or spec change moves the revision past
it, so the next approval is a new version (`packages/db/src/proposal-version.ts`,
migration 0050).

**Three steps, each versioned, none locked.** A bounty is made in order:
its overview (title and description), the bounty (its proposal's
`version`) and its sandbox (`sandbox_version.version`). The overview's
version is `bounty.version`, moved by a change to the title or the
description, whether written here or refreshed from Jira; each one is kept
in `bounty_version` (migration 0053, which backfilled every bounty's text
as its version 1). Each step records the version of the step before it
that it was built on. A proposal's overview version is the latest
`bounty_version` whose text hashes to its `spec_hash` (`overviewVersionOf`
in `packages/core/src/stages.ts`), so nothing is stored for it. A sandbox
version's bounty version is `sandbox_version_source.proposal_version`, the
proposal's version when its task was taken while approved, and null
otherwise and for versions taken before it was kept. No step holds another:
the overview is edited under an approved proposal, and a proposal is
unapproved or re-priced while its sandbox is published. A step built on an
earlier version than the step before is now at is behind (`stageDrift`),
which the bounty's detail answers as `stages` and the page shows on the
step's tab and at the top of its page. `GET .../bounties/:id/versions`
lists the overview's versions.

**An overview is approved as a proposal is.** `POST .../bounties/:id/approve`
and `/unapprove` (owners and admins, against `expectedRevision`) record or
clear `bounty.approved_version` with who and when (migration 0054). While
that is the overview's version (`overviewApproved`) its title, description,
repository, stack and Jira link are held: a change is refused
`overview_approved` until it is unapproved. Jira is not held back: a refresh
that makes a new version leaves the approval behind, and the overview reads
as unapproved again. A proposal is re-analyzed only while it is not
approved.

**A bounty has one sandbox, and the sandbox three faces.** `sandbox.bounty_id`
is unique and required, and a bounty with a sandbox cannot be removed. The
private face is `sandbox_source` and `sandbox_version_source`: the source
repository, alias table, approved task and hidden tests. The public face is
`sandbox` and `sandbox_version`, the aliased copy contributors work in. The
protected face is `submission`: one contributor's patch, pinned to the
version it was made against and run with the public and hidden tests
together. A submission's verdict is `submissionVerdict` in
`packages/core/src/sandbox/submission.ts`: every test in both suites, and
at least one hidden test, must pass. Only counts are kept, never hidden test
names, and only a frozen version takes a submission. No route takes a
submission yet; the table and its store (`packages/db/src/submissions.ts`)
are the shape the contributor flow will write.

**The repository is enrichment for a sandbox too.** A sandbox is made with
or without one (`POST .../sandboxes` with `bountyId` and an optional
`sourceRepoId`); `sandbox_source` exists only when it has one. Cutting a
version is a slice, so that alone needs it, and is refused `no_source`
without. One made without a repository has it linked later, once
(`PUT .../sandboxes/:id/source`): its versions are bound to the repository
they were sliced from, so a different one is refused `source_linked`.

**Without a repository, a version is generated.** `POST
.../sandboxes/:id/starter` snapshots the task from the bounty itself (its
title and description, with its live proposal's spec and price) and queues
a `sandbox_starter` run. The proposal must be approved: a bounty with none,
or with a draft one, is refused `task_not_ready`
(`starterTaskReadiness`). The run: an agent writes a
starter from the bounty's title, description and tech stack (its
repository's detected stack, when it names one, and what it adds), and the
worker builds it and checks its baseline as a build would. A starter is
source under `src/`, public tests that pass on it, hidden tests marked with
their outcome on it (at least one fails until the bounty is done), the
packages it installs, the walkthrough and a name table; its rules are
`packages/core/src/sandbox/starter.ts`. The starter is written in the
bounty's own vocabulary and leaves the workspace as a slice does: its name
table (identifier and text rules, at least one, each renaming something)
is applied with the inverse proof before the project is generated, and
becomes the version's `alias_rules`, so a generated version has a name
table like a sliced one. The contract is the sliced
project's: Node and TypeScript, so a stack that names only another runtime
(Python, Django, Go, ...) is refused `stack_unsupported`. The run is queued
first, naming the version's id, and the version is made pointing at it
(`starter_run_id`, which is also its `build_run_id`); `sandbox_version_source`
holds a version sliced or generated, never both. When the run commits, the
starter's hash, name table, hidden tests, scope and transform settle on the draft, with
the build's harness and toolchain when its baseline passed. A generated
version changes its listing like any draft, but its transform, its build and
its replay are refused (`generated_version`, or replay's
`source_unavailable`): it changes by generating a new version. Such a run
reads no snapshot, so `analysis_run.organization_id` owns every run (added
in migration 0049, backfilled through each run's snapshot). The bounty's
panel generates a version for a sandbox with no repository and follows its
run, and still offers to link the bounty's own repository to slice instead. A version's
frozen task names the bounty (`ApprovedTaskSnapshot.bountyId`, schema
version 3), and its spec and price must be that bounty's proposal's
(`proposal_mismatch` otherwise). Versions frozen earlier
keep what they were frozen with, because the snapshot is named by its hash:
version 2 lists `ticketIds`, from when a sandbox linked any number of
tickets, and version 1 lists `jiraIssueIds`.

**Publishing a version.** `POST .../sandboxes/versions/:vid/publish`
(owners and admins) records who approved the version and when, freezes it,
and makes it the sandbox's `current_version_id` with status `published`.
Only a version with a passing build is published: one with no recorded
harness and toolchain is refused `not_ready`. It stands on the approval its
task was taken from, not on the bounty's now: one whose task's proposal was
not approved is refused `bounty_not_approved`, and one that was publishes
whatever the bounty has done since. A version published before
keeps its first approval and is only pointed at again. `POST
.../sandboxes/:id/unpublish` takes the sandbox back to `draft` with no
current version; its versions stay frozen. No public repository is pushed
yet, and the round-trip and disclosure gates `freezeReadiness` names are
not run: publication marks the version contributors are to get. The
bounty's Sandbox tab shows the chosen version over its Slice card, as the
Bounty tab shows its proposal's version, with Publish or Unpublish beside
it.

**A version's private sandbox can be read, not changed.** `GET
.../sandboxes/versions/:id/files` lists what its build run (`build_run_id`,
sliced or generated) wrote: `project/`, the hidden tests under `private/`
and the build's own records, by path, size and hash; never storage keys.
`GET .../files/content?path=` answers one of them as text through the API,
since the bucket has no CORS for the browser to read a signed link. The
path is matched against the run's artifact rows, never joined into a key; a
file that is not UTF-8, or is over `SANDBOX_FILE_TEXT_MAX_BYTES`, is listed
with `text: null` and why. Both are owners and admins only, as the hidden
tests are among the files. The web app shows them at
`/sandboxes/:workspace/:versionId?path=`, a page outside the shell that the
bounty's Sandbox tab opens in a new tab once the build has succeeded.

**Migration 0046** dropped a bounty's issue type, priority and labels, and
the type and priority a profile froze. Version 1 of the spec hash read the
type, so before dropping it the migration recomputes each proposal's and
spec revision's version 1 hash in SQL. Where that matches the stored hash,
it writes version 2, the hash without the type, so a proposal still
current stays current; one that does not match was already stale and stays
on version 1, which reads as stale (`hash_version`).

**Migration 0045** renamed tickets to bounties: the `ticket` table, every
`ticket_id` column, the `ticket` run kind and the `ticketId` keys inside a
run's plan and outcomes and a profile's JSON. It replaced `sandbox_ticket`
with `sandbox.bounty_id`. Each old link goes to the oldest sandbox that held
it, and each sandbox takes its lowest-numbered one. A sandbox left with none
is given a bounty of its own, titled after its newest version, so no
sandbox is lost. Old bounty ids keep their `tkt_` prefix; new ones are
`bty_`.

**Migrations 0043 and 0044** made every existing `jira_issue` a bounty and
moved what pointed at the issue to point at the bounty. Bounty text had
lived only in Jira, so the backfill could copy only a title (the latest
run's plan, else the key); the rest arrives on the next Jira read. Until
then such a bounty shows no description, and one whose issue has gone
reviews as stale, since the stored text is not what was priced.

The web app's Bounties page (`/bounties`) lists the bounties of every
workspace the person is in, newest first, from `GET /api/v1/me/bounties`.
That route is outside the membership guard: it reads the caller's own
memberships and lists across them with `BountyStore.listAcross`, which takes
the organizations as given. A team workspace's bounty is tagged with the
workspace's name; a personal one's carries no tag. An opened bounty is read
and changed through its own workspace's routes, as the role held there
allows. A new one is written on its own page, `/bounties/new`, to the
workspace in the rail unless the form names another; once saved, it opens on
the Bounties page in the form's place in history. A bounty's tech stack is
its repository's detected stack, shown locked and followed live rather than
copied, plus what the bounty adds (`bounty.stack`), which is all a write
sends. Like the repository, the stack can be set on a bounty whose text
follows Jira. The page lists bounties as cards and has no list of
proposals: a proposal is made from a bounty and opens inside it. A bounty
opens in a panel over the list, `/bounties?peek=:workspace/:id`, or as a page
of its own, `/bounties/:workspace/:id`, which the panel's Open as page leads
to and whose trail leads back; a card links the page, and a plain click
opens the panel. The workspace is its handle, naming the routes the bounty
is read through. Its page splits it into its three steps, numbered tabs
named by `?tab=`, each with its version and a warning when it is behind;
the panel is one view, with no tabs: its description,
then its **Proposal**, and beside them on a wide page (below them otherwise)
its **Sandbox** and **Context**: its Jira issue and repository, each optional.
A bounty with no proposal offers to make one in the proposal's place; once
it has one, that place holds the live proposal in the same peek a board uses,
where it is reviewed and decided, without the peek's Spec tab or Jira link,
since the bounty shows both. The old `?bounty=…&workspace=…&proposal=…` query,
the per-workspace `/o/:slug/bounties` and `/o/:slug/tickets?ticket=…`
addresses, the old `?tab=proposals&proposal=…` and `/proposal` after either
address, from when the proposal was a tab, all still land on the right
bounty. A Jira board's page keeps its own list of the proposals its runs made.

## Pricing

[`apps/api/src/pricing/executor.ts`](../apps/api/src/pricing/executor.ts)
coordinates drafting and sizing. The sizing model sees the bounty text and
returns a whole size (`XS` through `XL`, or `unsized`), never a price.
`priceFor` in `packages/core/src/sizing.ts` applies the organization's saved
rate-card snapshot; a `+` size uses the rounded midpoint between adjacent
prices, in minor currency units. Unsized bounties have no price.

Spec revisions add half steps for net scenario weight gained since the sized
draft (`packages/core/src/pricing/step.ts`). Light, moderate, and heavy scenarios
default to 1, 2, and 4 points, with four points per half step; board overrides
are snapshotted with the run. Trimming can reduce the step, never below its
base, and XL is the cap. A fresh draft starts at step zero.

Manual resize changes the base while preserving the step and saved card.
Respec keeps the base, card, and step settings without another sizing call;
reprice uses the current card and starts fresh.

**The pricing rubric sizes a proposal once its code is measured**
(`packages/core/src/pricing/rubric.ts`, `rubric-v1`). It scores three
dimensions from countable evidence. Scenarios are scored by weight, with the
step's points, plus open questions. Test cases are one per scenario, plus each
outcome step after a test's first. Code comes from the complexity profile:
slice size, touched modules, services, seams, untested modules, migrations,
stubs and blockers, minus a discount for an analogous pattern. The total falls
in a band of the nine priced sizes, and the rate card prices it. Sizing stores
the assessment (`bounty_proposal.rubric`, migration 0051) with the code
`pending` or `unavailable`, so the model's size stands. When the profiler
settles a profile, `RubricPricer` (`apps/api/src/pricing/rubric.ts`)
re-scores the current spec and sets `sized_by = 'rubric'` on a proposed
proposal. A reviewer-sized proposal only has the assessment recorded, and an
approved one is not touched. A respec of a rubric-sized proposal is priced at
the rubric's score of the changed spec, and the step still records what
changed. `POST .../proposals/:id/rubric` puts the rubric's size back over a
reviewer's resize. Without a repository the rubric has no size, and the model
and step price the bounty as before. Provider wiring is in
`apps/api/src/server.ts`: Anthropic first with DeepSeek as fallback when both
are configured, or either provider alone. See `.env.example` for configuration.

## GitHub

One GitHub App, used two ways, and neither is the sign-in OAuth app, which
asks for `read:user user:email` and only says who someone is.

- **Installation tokens** do everything unattended: listing what an
  installation can see, reading a repository, its branch head and its tree.
  They are minted from the App's key
  (`packages/github/src/installation-tokens.ts`), cached in memory until five
  minutes before they expire, and **never stored**. One cache per API
  process, shared by the routes, the webhook, the reconcile sweep and the
  snapshotter.

**Every installation token is narrowed to what its call is for.**
`installationClient` in `apps/api/src/github/credential.ts` takes a scope,
and there are two, both read-only: `discovery` (installation-wide,
`metadata: read`) lists and counts what an installation covers;
`repository` (one repository by GitHub's numeric id, `contents: read` and
`metadata: read`) reads that repository's pointer, tree and languages, and
the few dependency manifests its stack is detected from. So a
wider grant the App takes on later cannot reach these calls, and a token
minted for one repository cannot read its neighbours. A mint narrowed to a
repository the installation no longer covers is refused with 422, which
reads as `GithubNotFound` and marks the repository `gone`, exactly as the
unnarrowed read used to.

- **The App's user-to-server half** runs the connect flow. The person's grant
  is kept in `github_grant`, encrypted like Jira's tokens, and used for one
  thing: proving which installations the person may link (below). It lives
  as long as their membership: a trigger on `member` (migration 0038) drops
  it however the membership ends, since the organization plugin's `leave`
  route runs no hook.

**The callback's `installation_id` is untrusted.** It is a small integer
anyone can type, and the signed state proves only that the person started a
flow for their own organization. An installation is linked only when it is in
that person's own installation list, whether its id came from the query or
from the picker. `github_connection.installation_id` is unique across the
table, so an installation belongs to one organization; another
organization's attempt is `claimed`, and the conditional upsert in
`GithubConnectionStore.link` writes nothing.

**Being in that list is not authority.** GitHub lists every installation
covering a repository the person can reach at all, so an outside
collaborator on one repository sees the whole organization's installation.
`apps/api/src/github/authority.ts` checks again before anything is linked: a
personal account's installation must be the person's own account, and an
organization's must cover no repository the person cannot already read
(their per-installation repository count equals the installation's). That
needs no App permission beyond Contents and Metadata; proving the person
administers the organization would need Members: read.

**The flow starts at the OAuth authorize URL, not the install page.** The
install page returns to the callback only for a fresh install, so
reconnecting an installation that already exists would strand the person on
GitHub's settings page. The callback sends them to the install page only when
their list holds nothing to link.

**Repositories are pointers.** A `github_repo` row is GitHub's numeric id
(which survives renames), a name, and the commit its default branch points at.
Two writers keep that commit current: the webhook (`POST
/api/github/webhook`, outside the session guard, signature checked over the
raw bytes before parsing), and a reconcile sweep every five minutes for
repositories not read in fifteen, which sends `If-None-Match` so a quiet
repository costs nothing against the rate limit. A push only moves the head
when its `pushed_at` is no older than the one recorded, so a late delivery
cannot move it backwards; one in the same second leaves the row due for the
next sweep, which reads the branch itself. No write but `register` and
`revive` brings a `gone` repository back.

**Every head is snapshotted.** Registering a repository, a push that moves
its head, a new default branch and every sweep read ask
`apps/api/src/github/snapshot.ts` for a snapshot of the head, which is a
no-op once one exists for that `(repository, commit)`. Taking one reads the
recursive tree and the language totals with a repository-scoped token,
writes the file list (paths, sizes, Git object ids; never contents) gzipped
to `trees/<repoId>/<sha>/<objectId>.json.gz` in the private bucket, computes
`TreeFacts` (`packages/core/src/repo/tree.ts`: modules, sizes, extensions,
tests, lockfiles, migrations, infrastructure), and inserts a
`repo_snapshot` row. The commit is read once, at the start, so a row always
describes the commit it names; a newer head is a newer row. The work is
queued off the request path, a few at a time, and a job that fails is
retried by the next sweep, which asks again for every repository it reads.
A `gone` repository takes no new snapshot, checked again under a row lock
when the row is written. The newest 20 unreferenced snapshots per
repository are kept; one a proposal was drafted beside is kept however old.
Each snapshot attempt uses a unique object key, so delayed pruning cannot delete
a recreated snapshot of the same commit. Unsuccessful attempts remove their own
objects, and disconnecting an installation collects all tree keys before the
database cascade. Proposal writes lock surviving owned snapshots until commit
and omit a snapshot deleted during drafting. Pruning waits for these writers
before rechecking references.
Snapshots need object storage: without a bucket none are taken and the
snapshot routes answer 503.

**A repository's tech stack is detected beside its snapshot.**
`apps/api/src/github/stack.ts` picks up to 30 dependency manifests from the
tree (`package.json`, `pyproject.toml`, `pom.xml`, `*.csproj`, `go.mod`,
`Gemfile`, `Cargo.toml`, compose files and Dockerfiles, Terraform), shallowest
first and none over 256 KiB, reads them by Git object id with the same
narrowed token, and hands them with the language totals and the file list to
`detectStack` (`packages/core/src/repo/stack.ts`). That is the one read of
file contents outside the worker: each manifest's text is dropped once read,
and only the names found are kept, on `github_repo.stack` with the commit and
detection version they came from. Vendored code, fixtures and examples are
skipped. A snapshot that already exists has its stack redone when either is
stale, so the sweep backfills every repository within one interval and a new
`STACK_DETECTION_VERSION` redoes them all; a failed read is reported and
retried the same way, and never fails the snapshot. The names come from one
catalog (`packages/core/src/stack.ts`), which also groups them by kind for the
picker and stores other spellings (`postgres`, `k8s`) under its own.

**A bounty can name the repository it is about** (`bounty.repo_id`), and
**a board can name one for its bounties** (`jira_board.source_repo_id`);
both same organization only, checked in the write. A bounty's own wins,
and a Jira bounty that names none takes its board's. Sizing then drafts
each spec beside an outline of that repository's current snapshot —
module names with file counts and file types, capped at 60 lines
(`apps/api/src/sizing/outline.ts`) — and records the snapshot on the
proposal (`bounty_proposal.repo_snapshot_id`). The size call is never
shown it.

**A delivery is applied before it is answered.** GitHub does not retry a
failed delivery on its own and records any 2xx as delivered, so the
database writes run first and a failure answers 500, which GitHub shows as
failed and lets someone redeliver. Only the head re-read after a
default-branch change is left until after the 202.

**The sweep tells the App's failures from an installation's.** A 401 to the
App's JWT (a deleted key, a wrong App id, a skewed clock) stops the sweep and
flags nothing, since every installation would answer the same. A rate limit
skips only that installation, as GitHub's limits are per installation. A
connection flagged unhealthy is probed with the JWT on each sweep until it
recovers or GitHub says it is gone, which sets `uninstalled_at` and is final:
a reinstall is a new installation id. Reconnecting clears either.

Both connect flows sign their `state` with the same secret, so the state
carries a `purpose` (`apps/api/src/connect-state.ts`) and each callback
refuses the other's.

**Analysis runs are private and cached.** Five _context builders_ describe a
snapshot on their own, started from a repository's page
(`/o/:slug/repositories/:repoId`) by an owner or admin and read by any
member: a `graphify` run maps a snapshot's structure in a Fargate worker; a
`dependency_cruiser` run cruises its module dependencies, cycles and
orphans; a `deepwiki` run asks a self-hosted DeepWiki-Open service for a
wiki of the repository (and, unlike the others, that service reads the
repository's default branch itself; the run records which commit it was
asked for); an `abstractions` run lists every module's exported surface
with its signatures, typed, syntactic or names only; and a `data_model` run
reads the entities, enums and relations the repository's Prisma schema,
Drizzle tables or SQL migrations declare, with the modules that touch them.
The last two read graphify's map and are what the agents read. A `slice` run reads the graphify map and the same source to cut
the files one task needs and describe their boundary (the stubs it imports
from outside, the public surface outside code imports from it, the
externals to mock). All are `analysis_run` rows keyed by `(snapshot, tool,
version, params)`, reached only through the repository's owner, with their
artifacts in the private bucket under `runs/<runId>/`. A builder other than
graphify names itself in its parameters (`params.builder`), since their
parameters are otherwise the same. A slice, a scope run and the
`abstractions` and `data_model` builders name the graphify run they read
(`params.graphRunId`) and are handed to a worker only after that run has
finished; the API enqueues the graph run first when there is none. The walk and the record shapes are pure code in
`packages/core/src/slice`; `apps/worker/README.md` states every output
contract. A slice is a proposal: `stubCoverage: "full"` with no blockers
lets it proceed to the provenance checks in
[`packages/core/src/sandbox/provenance.ts`](../packages/core/src/sandbox/provenance.ts).
Anything less remains diagnostic output and cannot produce a ready sandbox.
A slice is cut for a bounty by the profiler and the sandbox flow, never by
hand from the repository page, which only builds context.

**Agents propose; deterministic code decides.** A `scope` run gives a model
read-only tools over the extracted source and the bounty's approved spec,
and it proposes a slice request: entry points and a budget chosen so the
cuts fall on input/output seams. Its `check_scope` tool runs the very slice
computation the `slice` tool runs, and an answer is recorded only when that
computation agrees with it. When the snapshot has succeeded `abstractions`
or `data_model` runs, the scope run names them (so they join its cache key)
and the agent can read a module's surface and the data model, whose
accessor modules are where a `database` seam belongs; the fixtures agent
reads the data model too. Neither decides anything. The proposal fills the slice picker; a person
starts the slice. A `fixtures` run, for a succeeded slice, writes default
behaviour for mocked calls and the `npm run dev` walkthrough, type-checked
against the slice's own stubs; a version copies them into its transform,
and the build aliases them and runs the walkthrough in its baseline. The
source is read only during a run: transcripts and tool results are never
stored, only the structured answer, its token usage and fixed log lines.
Agent runs need `ANTHROPIC_API_KEY` and `AGENT_MODEL` on the worker; without
a key they fail `agent_unavailable` and nothing else changes.

**A sized bounty is profiled from the code it touches.** When a spec is
drafted beside its bounty's surviving repository snapshot and profiling is
configured, the proposal/spec transaction inserts the pending profile intent
(`bounty_profile`, one row per revision), with the owner, spec hash and
locked snapshot. An intent
insert failure rolls back the proposal and spec. The post-commit callback only
wakes the profiler: a later sweep discovers committed intent without it. The
unique proposal/revision constraint makes requests idempotent. Snapshot-less
or disabled profiling retains the existing behavior; respec does not implicitly
request profiles, and historical rows are not backfilled.
`apps/api/src/pricing/profiler.ts` sweeps the rows in flight every 30
seconds, since the worker reports a finished run only to the database: it
enqueues the snapshot's graph and a `scope` run for the spec (no person
behind either, so `requested_by` is null), then slices exactly the request
the scope recorded, then builds the profile with `buildComplexityProfile`
(`packages/core/src/pricing/profile.ts`). The profile is evidence, not a
price. It holds the slice's files, bytes and modules, the modules the
scope's entry points touch, the services and environment the slice reaches,
the spec's open questions and assumptions, the test files in the touched
modules, migrations and CI, and an existing file the scope agent names as
the pattern to follow, which the worker checks is a real file. A step that
meets the organization's analysis cap waits for the next sweep, so a large
backlog queues behind the cap rather than failing; the profiler meets it a
slot early, so a person's own analysis is not refused while the backlog
drains. A failed run fails the
profile for that revision; a re-price drafts a new revision and asks again.
The whole chain needs what analysis needs, plus the agent's key.

**Sandbox versions pin their provenance.** A version is cut from a succeeded
slice. Its private source row records the slice's manifest and contract
hashes, the transform (alias rules, dependency choices, hidden tests) and a
snapshot of the approved task; fixtures, when attached, are part of the
transform too. A transform change clears every piece of evidence gathered
for the old one. A `sandbox_build` run, another
`analysis_run`, generates the standalone project and runs its baseline
through an evaluation provider. Only a worker started with
`EVALUATION_PROVIDER=local-process` runs builds, and that provider is not an
isolation boundary. A repository a sandbox is built from cannot be removed,
alone or with its connection, because replay needs its snapshot.

**The extension runs a task locally.** It reads `sandbox-task.json` from a
clone for display only and runs the fixed command table from
`packages/core` in VS Code terminals, only when invoked, in a trusted
workspace. The API address is a user or application setting; a workspace
value is ignored, and the stored token is keyed by origin.

## Not yet built

- **The extension's sign-in** — the client's `getToken` callback is the seam,
  reading VS Code's encrypted secret storage. The API already accepts the token.
