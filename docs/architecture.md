# Architecture

## Dependency direction

Dependencies point downward only. Nothing below imports from above.

```
apps/api        apps/web        apps/extension
     │    │          │                │
     │    │          └────────┬───────┘
     │    │                   │
     │    │         packages/client
     │    │                   │
     │    └───────┬───────────┘
     │            │
     │    packages/shared
     │            │
     │            │
  packages/db ────┴──── packages/core
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

Three of these are enforced or load-bearing:

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
repo. Only `apps/api` imports it.

## Domain rules live in `packages/core`

[`packages/core`](../packages/core/src/index.ts) owns what a valid public
handle is. Everything else asks it: `apps/api` calls `normalizeHandle()` before
storing one and maps the refusal to a 400; `apps/web` calls `isValidHandle()`
and `toHandleStem()` in the rename forms.

It is a genuine domain rule rather than a wire concern, because users and
organizations draw handles from **one namespace** — a personal organization
takes its owner's handle — so what counts as valid has to be decided once.

`packages/shared` refines core's rules in `handleSchema` rather than restating
them, so a change to the rules cannot leave the two disagreeing.

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
[`apps/api/src/store.ts`](../apps/api/src/store.ts) re-exports both.

`createInMemoryStore` is a **test double**, not a fallback. The server requires
`DATABASE_URL` and will not boot without it.

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

## Tickets

**A ticket is the platform's own record of a piece of work**, and every
proposal prices one (`bounty_proposal.ticket_id`). It is written here, or
imported from Jira by a run, and either way it is one `ticket` row,
proposed, reviewed and cut into a sandbox the same way. Jira, GitHub and
any source added later enrich a ticket; none of them is required. A
deployment with a model and no Jira or GitHub configured sizes the
tickets written in it.

**Jira enriches a ticket rather than owning it.** A `jira_issue` row is the
pointer half of an imported ticket (`jira_issue.ticket_id`, one each): the
first run that reads an issue creates the ticket, and every read after —
a run, or opening one of its proposals — writes Jira's text back onto it
(`refreshFromJira`, only when it differs, so the revision does not move
for nothing). While the issue is there its text is Jira's to change, and
the API refuses an edit to it (`jira_owned`); its repository is the
platform's to set. When Jira stops returning the issue, the pointer is
marked `removed_at` and the ticket keeps the text it last had: it is then
sized, reviewed and edited as stored, like a ticket written here. If a
board's run finds the issue again, the pointer is restored and Jira's text
replaces the ticket's once more. Losing a board takes its pointers but not its
tickets; it does take the runs that read through it, and with them the
proposals those runs made (`bounty_run.board_id` and
`bounty_proposal.run_id` cascade).

**Freshness is the ticket's.** `ticketSpecHash` in `packages/core`
fingerprints a ticket's title, description and type, and
`packages/jira`'s `pricingSpecHash` is that function, not a copy, so a
proposal priced from Jira's text and one priced from the stored copy
compare. A proposal is current while its ticket still hashes to what it
was priced from: read live from Jira while the ticket follows an issue,
and as stored otherwise.

**A ticket is named by its Jira key while it has one, and by its
organization's own number otherwise** (`T-12`, `ticket.number`, unique per
organization and taken as the next after the highest in the insert
itself, retried in a savepoint on the rare collision).

**Runs.** A `ticket` run sizes one ticket someone proposed
(`POST .../tickets/:id/propose`); `reprice` and `respec` runs name their
proposal's ticket too. Those three need a board only when the ticket came
from one, whose selection and pricing settings they then use; otherwise
the defaults. `backlog` and `issue` runs read a Jira board and import what
they reach. A ticket following its issue cannot be read while its site
needs reconnecting, and its run fails `reconnect` rather than sizing
stale text. Approval posts back to Jira only for a ticket still following
an issue on a site that holds the write grant.

**Sandboxes link tickets** (`sandbox_ticket`), and a version's frozen task
names them (`ApprovedTaskSnapshot.ticketIds`, schema version 2). A version
frozen before tickets keeps its version 1 snapshot with `jiraIssueIds`:
the snapshot is named by its hash, so it is read as written, never
rewritten.

**Migrations 0043 and 0044** made every existing `jira_issue` a ticket and
moved what pointed at the issue to point at the ticket. Ticket text had
lived only in Jira, so the backfill could copy only a title (the latest
run's plan, else the key); the rest arrives on the next Jira read. Until
then such a ticket shows no description, and one whose issue has gone
reviews as stale, since the stored text is not what was priced.

The web app's Tickets page (`/o/:slug/tickets`) lists the organization's
tickets, writes and edits them, proposes them, and lists every proposal
from any source in the same peek a board uses.

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
`metadata: read`) reads that repository's pointer, tree and languages. So a
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

**A ticket can name the repository it is about** (`ticket.repo_id`), and
**a board can name one for its tickets** (`jira_board.source_repo_id`);
both same organization only, checked in the write. A ticket's own wins,
and a Jira ticket that names none takes its board's. Sizing then drafts
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

**Analysis runs are private and cached.** A `graphify` run maps a snapshot's
structure in a Fargate worker; a `slice` run reads that map and the same
source to cut the files one task needs and describe their boundary (the stubs
it imports from outside, the public surface outside code imports from it, the
externals to mock). Both are `analysis_run` rows keyed by `(snapshot, tool,
version, params)`, reached only through the repository's owner, with their
artifacts in the private bucket under `runs/<runId>/`. A slice names the
graphify run it reads and is handed to a worker only after that run has
finished. The walk and the record shapes are pure code in
`packages/core/src/slice`; `apps/worker/README.md` states the output contract.
A slice is a proposal: `stubCoverage: "full"` with no blockers lets it reach
the sandbox plan's gates, and anything less is diagnostic output that cannot
be published.

**Agents propose; deterministic code decides.** A `scope` run gives a model
read-only tools over the extracted source and the ticket's approved spec,
and it proposes a slice request: entry points and a budget chosen so the
cuts fall on input/output seams. Its `check_scope` tool runs the very slice
computation the `slice` tool runs, and an answer is recorded only when that
computation agrees with it. The proposal fills the slice picker; a person
starts the slice. A `fixtures` run, for a succeeded slice, writes default
behaviour for mocked calls and the `npm run dev` walkthrough, type-checked
against the slice's own stubs; a version copies them into its transform,
and the build aliases them and runs the walkthrough in its baseline. The
source is read only during a run: transcripts and tool results are never
stored, only the structured answer, its token usage and fixed log lines.
Agent runs need `ANTHROPIC_API_KEY` and `AGENT_MODEL` on the worker; without
a key they fail `agent_unavailable` and nothing else changes.

**A sized ticket is profiled from the code it touches.** When a spec is
drafted beside its ticket's repository snapshot, the executor asks for that
spec revision's complexity profile (`bounty_profile`, one row per revision).
`apps/api/src/bounty/profiler.ts` sweeps the rows in flight every 30
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
