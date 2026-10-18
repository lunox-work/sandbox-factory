# Private repository analysis worker

Ten tools run here (`ANALYSIS_TOOLS` in `packages/core/src/analysis.ts`),
one adapter each under `src/tools/`; the header comment of each file says
how it works, and this file says what it promises. Five are context
builders: Graphify analyzes an immutable snapshot with `graphifyy==0.4.18`
and pinned parsers; abstractions and data model read its map for every
module's callable surface and the entities the repository stores; documents
keeps the Markdown; brief sums the others up. Slice reads the graph and the
source to describe the files one task needs and their boundary. Sandbox
build turns a slice and a version's private transform into a runnable
project and checks its baseline in an evaluation job. Scope and fixtures
are agent runs: a model proposes a slice for a bounty, and writes behaviour
for a slice's mocked calls. Starter is the one run with no repository: a
model writes a generated version's project from the bounty's text, built
and checked like a slice's. Only the build and the starter execute generated
code, and only inside the evaluation provider's job; only the agents call a
model.

Every tool keeps four rules: no repository code is executed and none of its
dependencies installed; the same snapshot and parameters give the same
bytes; coverage is recorded per module, never implied; finding nothing is a
success with empty output.

## Run locally

Configure the GitHub App in `.env.development`, start dependencies, and apply
local database migrations with `make migrate`. `make up` starts the polling
worker alongside the API and web app. Open a registered repository's page
and choose **Build** on a context builder. Any organization member can open
artifacts; owners and admins can start runs and read logs. A sandbox
build's artifacts, hidden tests among them, are owners' and admins' only.

`make worker-smoke` builds the production image and runs the real pipeline on
the checked-in fixture without GitHub, database or AWS credentials: archive
validation, import resolution of every kind, graph direction, artifact
upload, identical graph, `abstractions.json` and `data-model.json` bytes
from two checkout paths, and a slice of the resulting graph. Unit tests
inject subprocesses and storage; real PostgreSQL tests exercise concurrent
claims, spend limits and stale leases.

## Run lifecycle

Runs are `analysis_run` rows cached by `(snapshot, tool, version, canonical
params hash)`; the same inputs are one run. Each attempt owns a unique lease
and storage prefix, so a late worker cannot overwrite its successor, and
completion inserts artifacts and changes status in one fenced transaction
(`packages/db/src/analysis-runs.ts`, modelled in `docs/specs/RunLease.tla`).
A heartbeat runs every 15 seconds, the lease lasts 60 seconds, and the
default deadline is 30 minutes. A watchdog retries lost workers twice;
manual retries share that limit. SIGTERM stops new claims and allows the
runs in its slots 60 seconds before cancellation and release.

A worker has slots by kind (`WORKER_SLOTS` in core, `src/loop.ts`): three
for agent runs (`scope`, `fixtures`, `sandbox_build`, `sandbox_starter`) and
one for builds (the context builders and `slice`). It claims into any free
slot beside the runs it already has, oldest run of the organization with the
fewest running first. A claimed `abstractions`, `data_model` or `documents`
run shares its claim with the others queued on its snapshot (`claimBeside`)
and runs them at once on one checkout, each with its own lease; a shared
claim takes one build slot. At most two evaluation jobs run at once on a
worker (`limitJobs`, modelled in `docs/specs/JobLimit.tla`). Within an
agent's turn, reading tools run together; checks, runs and submits run
alone, in order.

Every run that ends writes where its time went to `analysis_run.timing`
(`src/timing.ts`): stages in milliseconds, each agent turn's model and tool
calls, each baseline step's duration. Durations only, never inputs or
output; a released run writes none. A build or starter lists the files it
has generated on `analysis_run.preview` before its baseline runs
(`preview` in `src/tools/adapter.ts`, under `runs/<id>/<lease>/preview/`),
best effort and cleared when the run ends. Each change a page shows (claimed, a step, a preview, ended) is
announced on `run_changed` for the API's push channel.

### Source on disk

A run that reads source checks it out of the worker's source cache
(`src/source-cache.ts`), kept under the OS temp directory by
`(repository, commit)` and bounded at 4 GiB (`SOURCE_CACHE_BYTES`), so a
commit's builders, scope, slice and build fetch and extract it once. Runs
read the tree and never write to it. On a miss the archive is read from the
private bucket (`sources/<repoId>/<sha>.tar.gz`) before GitHub and written
there once unpacked; the bucket expires them after 30 days, and removing
the repository removes them (`src/fetch-source.ts`).

The local evaluation provider gives each job a private home and temporary
directory (npm logs there too) and an npm cache outside its directory: one per
job uid on a root worker, of which only `_cacache` outlives a job, one for
every job otherwise. Installs reuse it, checked against the lockfile's sha512
integrity; the lockfile preparation step resolves in an empty cache of its own
instead. The worker keeps the lockfile that step
produced for each set of dependencies, keyed by what `package.json` asks to
install, and reuses it only while its root entry matches that manifest and
every package is its own `registry.npmjs.org` tarball with a sha512
integrity (`src/evaluation/lockfiles.ts`); on a root worker the store's
directory is one jobs cannot write. A root worker checks at startup that it
can run processes as each job uid, then runs each job as a uid of its own
from `EVALUATION_JOB_UID` (at least 10000, one per concurrent job, the range
clear of 65534) and, after the job, kills everything that uid runs, confirmed
by a `/proc` scan, and removes what it owns under `/tmp`, `/var/tmp` and
`/dev/shm`; a uid it fails to clear is held back until a later sweep succeeds.
That keeps the worker's process environment, caches and other jobs' files from
a job, not what is world-readable or the network. In compose the worker mounts
the checkout read-only where job uids cannot enter and runs a root-owned copy
of what it builds from (`/repo`, without `.git`, env files, keys or build
output, made at each start; see the `worker` service in
`docker-compose.yml`): a job reads that copy but cannot change it, and reaches
Postgres and SeaweedFS with their development credentials. Any other worker
runs jobs as itself and warns once (`src/evaluation/isolation.ts`).

## Output contract

### Graphify

`graph.json` is the canonical, directed graph with parallel relations and
relative source paths; module-qualified IDs preserve same-named exports.
TypeScript's compiler API resolves literal imports using the nearest
tsconfig; external, unresolved and nonliteral imports stay visible as
dependency nodes and omissions. Other languages keep Graphify's AST
extraction and recorded unresolved targets. This is structural evidence,
not runtime reachability. `graph.html`, `GRAPH_REPORT.md` and `wiki/*.md`
are presentation views whose simple graph can collapse parallel relations;
the HTML view shows at most 5,000 nodes, chosen by degree. `manifest.json`
records coverage, omissions, counts, confidence and the canonical graph
SHA-256; timing fields do not enter the digest.

### Context builders

`abstractions`, `data_model`, `documents` and `brief` are queued like
graphify from `POST .../repositories/:id/runs` with the builder's name as
`tool`; their parameters are graphify's plus a `builder` discriminator, and
for the two that read the map `graphRunId`, the succeeded graphify run on
the same snapshot, which the API enqueues first and the queue waits for. A
graph that did not succeed fails them `graph_unavailable`. Each writes a
`manifest.json` whose `meta` is the summary the console reads (the
`*SummarySchema`s in `packages/shared/src/analysis.ts`).

**abstractions** (`src/tools/abstractions.ts`) lists every module's callable
surface: language, importer count and exports with signature, line and the
types each names. Three tiers, each module at the highest that can read it:
`typed` (TypeScript and JavaScript through the compiler, one program per
nearest `tsconfig.json`, in a worker thread; a program past
`PROGRAM_FILES_MAX` of 2,000 files drops to the next tier with a
`program_too_large` omission), `syntactic` (Python, Go and Java with the
pinned tree-sitter grammars, `python/abstractions.py`; signatures as
written, no types resolved) and `names-only` (the graph's symbol nodes). An
export takes the graph's symbol id when the graph has a node of its name at
its line, else `symbol:<path>#<name>`, so the scope agent can move between
the two. Outputs: `abstractions.json` (kind `abstraction_index`),
`abstractions.md` (kind `other`, at most 300 modules or 256 Ki characters)
and `manifest.json` (`abstractionsSummarySchema`). Limits are
`ABSTRACTION_LIMITS` in core: 500 exports per module, 8,000 characters per
signature, each cut an omission. Beside them, `seams.json` (kind
`seams_index`, `seamsIndexSchema`) lists per module the service imports and
environment names the slice would list, read with the slice's own
`detectExternals`; a file over 1 MiB or past 50 services or 100 names is
`partial`, and past 20,000 entries the index stops at `coveredThrough`.

**data_model** (`src/tools/data-model.ts`) reads the entities, fields,
enums and relations a repository stores, and the modules that touch them,
with three recognizers that run only on their evidence: Prisma schemas
(`data-model/prisma.ts`, a parser written here), Drizzle tables
(`data-model/drizzle.ts`, from the syntax of files importing a Drizzle core
module) and SQL migrations (`data-model/sql.ts`, replayed with
`libpg-query@18.1.5` on an in-memory catalog; nothing reaches a database).
When two define one table the declared schema wins, Prisma, then Drizzle,
then migrations, and the other counts it `shadowed`. Accessors are the
modules that read or write an entity (`data-model/accessors.ts`), ranked by
entities touched, then importers. Outputs: `data-model.json` (kind
`data_model`), `erd.mmd` (kind `erd_mermaid`) and `manifest.json`; both JSON
artifacts carry the summary (`dataModelSummarySchema`).

**documents** (`src/tools/documents.ts`) keeps the repository's Markdown
documents, every one a bounty's sync could read (`repositoryDocuments` in
core), at most 200, each cut to `CONTEXT_DOCUMENT_CHARS`. Output:
`documents.json` (kind `documents`, a `DocumentSet`, `documentsSummarySchema`).
A sync and a pin read it instead of GitHub.

**brief** (`src/tools/brief.ts`) is one bounded document per snapshot
(`renderBrief` in core, at most `BRIEF_MAX_CHARS`, most telling first so a
reader with less room keeps a prefix, `cutBrief`). It reads the newest
succeeded `abstractions`, `data_model` and `documents` runs on its snapshot,
and the queue holds it until no other builder there is queued or running
(`BUILDER_READERS`); a builder that failed is left out. No model. Output:
`brief.md` (kind `brief_md`, `briefSummarySchema`). The draft and the size
read every connected repository's brief under one shared cap
(`briefCharsEach`).

**Adding a builder** follows an existing one through: `CONTEXT_BUILDERS`,
its tool version, params guard, `GRAPH_READERS` or `BUILDER_READERS` and
`ARTIFACT_KINDS` in `packages/core/src/analysis.ts`; the params and summary
schemas in `packages/shared/src/analysis.ts`; the same-snapshot graph check in
`packages/db/src/analysis-runs.ts`; enqueueing in `apps/api/src/analysis/routes.ts`;
`src/main.ts` and `src/tools/<builder>.ts`; and `labels.ts`, `BuilderRow.tsx`
and a result component in `apps/web/src/features/analysis/`.

### Slice

A slice run (`src/tools/slice.ts`) names the succeeded graphify run on the
same snapshot (`params.graphRunId`), its entry points (repository paths), a
budget (`maxFiles`, default 40; `maxDepth`, default 3) and whether
graphify's inferred edges are walked (`includeInferred`, default off). A
graph that did not succeed fails it `graph_unavailable`. `reach`
(`packages/core/src/slice`) walks the graph breadth first over import, call,
inheritance and use relations until the budget is spent: files inside are
_included_, dependency edges that leave the set are _cuts_, and outside
files' imports of included modules are the _public surface_. For
TypeScript and JavaScript the cut modules get declaration stubs from the
compiler's own emitter, without comments, literal values (constants, class
properties, `as const` objects and tuples and literal annotations, widened
to `string`, `number`, `bigint` or `boolean`; a string enum member's value
becomes its name) or private member names (one `#private` brand), narrowed
to the names asked for and what they reference (a namespace import's reads
unless it escapes). `@internal` declarations are kept when asked for or
referenced, without their comments; the contract's declarations are the
same text. A slice that
includes a credentials file (`isSecretPath` in
`packages/core/src/sandbox/secrets.ts`: env files, private keys, keystores
and credential configs, never their `.example`/`.sample`/`.template`) is
blocked `secret_file`. The whole is type-checked in memory with the
source's nearest `tsconfig.json`, packages declared untyped; other languages
get the cut modules by name and `stubCoverage: "names-only"`.

Outputs: `slice-manifest.json` (source commit, graph run and its SHA-256,
canonical parameters, every included file with blob id, SHA-256, mode and
size, every generated file, required build inputs, cut edges, externals,
blockers, the operation policy and the contract's hash),
`boundary-contract.json` (stubbed and public symbols with declarations,
compilation result, blockers), `stubs/<path>.d.ts`, `boundary.md`,
`public-surface.md` and `abstract.md`. `stubCoverage` is `full` only when
every symbol has a declaration and the fixture compiled; `partial` and
`names-only`, and any blocker (unknown entry point, unresolved or dynamic
import, missing build input, incomplete declaration, compile error), are
diagnostic and cannot advance to publishing. Externals are listed by import
specifier and environment variable name; values are never read. Each
package records whether it is a workspace package (`package.json`
`workspaces`, `pnpm-workspace.yaml`, `lerna.json`; `*` and `**` globs) and
the registry its lockfile and npm or Yarn configuration say it comes from
(`src/tools/package-registry.ts`).

### Sandbox build

A `sandbox_build` run (`src/tools/sandbox-build.ts`) names a sandbox version
(`params.sandboxVersionId`), its slice run and every hash the output must
bind to: the slice manifest and contract, the transform (alias rules,
dependency choices, hidden tests and fixtures; the starter's hash for a
generated version) and the approved task. The API queues it from
`POST /api/v1/orgs/:orgId/sandboxes/versions/:id/build`. The worker refuses
a run whose hashes no longer match the draft, or whose draft no longer
hashes to them (`tool_failed`), a slice that is not a succeeded run on the
same snapshot or whose artifacts fail their hashes (`slice_unavailable`),
and source bytes that differ from the manifest (`source_unavailable`).

The alias table is applied with the inverse proof from
`packages/core/src/sandbox/aliases.ts` to the source, stubs, contract, spec
and fixtures, paths included, and to the names of mocked packages and
environment variables; a collision, an irreversible rule, a value that no
longer reads as its schema or a renamed package or variable that is no
longer a valid name is an `alias_failed` blocker and nothing is generated.
The project generator (`packages/core/src/sandbox/project.ts`) writes the
aliased source with compiler-alias imports rewritten to relative paths, a
`.d.ts` stub and a recording-mock `.js` per cut module, a local `file:` mock
package per mocked package under `mocks/` by its renamed name (imports and
`process.env` reads follow), the harness
(`sandbox/mock.js`, `sandbox/run.ts`), public tests under `tests/public`,
hidden tests under `tests/private`, `package.json` pinning the approved
packages, `tsconfig.json`, `.nvmrc`, `.npmrc`, `sandbox.env` with fixture
values for every environment variable the slice reads, `README.md` and
`sandbox-task.json`. The local contract is `npm ci`, `npm run dev`,
`npm run build`, `npm test` on Node 22+, fixed in `packages/core`. Only
registry versions are installed: a dependency pinned to a URL, a path or an
alias is `dependency_unresolved`. A package installs by its real name only
when a lockfile resolves it from the public registry and no configuration
sends its scope elsewhere; any other is mocked by default, and one from
another registry can never be approved. Every build scans the public files
for the workspace's names (`packages/core/src/sandbox/vocabulary.ts`; an
organization's distinctive words too, and the scope, or multi-word name, of each workspace or private-registry package the slice imports) and blocks `vocabulary_leaked`, and for
credentials (`packages/core/src/sandbox/secrets.ts`) and blocks `secret_found`
by file, line and rule, never the value. Starters are scanned the same way.
`.gitignore` names only public files' output.

A sliced draft with no fixtures, hidden tests or pseudonyms has each written
by an agent during the build (`fixtures.ts` via `writeFixtures`,
`hidden-tests.ts`, `pseudonyms.ts`), kept only once its own check passes,
and settled on the draft when the run commits (`build-transform.json`; a
set written here names the build run as its `fixtureRunId`).
A set an agent could not settle leaves the draft without, and the build
goes on. A preparation run's set and table (`preparedRunId`, below) are
taken first.

The baseline runs in a fresh job from the evaluation provider: trusted
preparation pins the lockfile (`npm install --package-lock-only`), then
`npm ci`, `npm run build`, `npm run dev`, `npm test`, and each hidden test
on its own, reported as TAP, then every hidden test once more. At least one
hidden test must be expected to fail, and each must do what its
`expectedBaseline` says, with the same result for every test on both runs
(else `flaky`); a build or harness failure, or a test file that fails before
any test ran, is never accepted as that baseline. A pass is read from the
report's closing counts, not the exit code (`privateTestOutcome`, which
grading reuses). The job is destroyed on every path and its execution
record (provider, job id, environment, input hash, state, teardown) is kept
in the report. The provider contract is
[`packages/core/src/sandbox/build.ts`](../../packages/core/src/sandbox/build.ts).
The worker ships `local-process` (`src/evaluation/local-process.ts`): a
temporary directory and child processes with a scrubbed environment. It is
the development provider, **not an isolation boundary**, used only with
`EVALUATION_PROVIDER=local-process` (the compose file sets it) and refused
at startup with `NODE_ENV=production`. The default,
`none`, fails every build `evaluation_failed` before anything is generated.
Hosted execution of untrusted contributor code needs an isolated provider;
none is implemented.

Outputs: `build-manifest.json` (every generated file hashed and classified
public or private; harness, test and project hashes; the toolchain and its
digest; the evaluator environment; import rewrites, renames, dependencies,
blockers and the baseline report), `baseline.json`, `project/<path>` for
every public file including the lockfile, `private/<path>` for hidden
tests, and `private/pseudonym.lunox` (kind `pseudonyms`), the alias rules
the public files were renamed by; the private sandbox is `project/` read
back through that table's inverse. `ready` is true only with no blockers
and a passing baseline. Equal inputs and a fixed clock give manifests that
differ only in the job's id, provided the registry resolves the trusted
lock the same way; the lockfile is recorded so a difference is visible. A
ready build records its harness hash and toolchain digest on the draft
after the run commits, only while the draft still points at it.

### Scope and fixtures (agents)

Both are a manual tool loop (`src/agent/loop.ts`) over the Anthropic
Messages API: one streamed call per turn, strict tool schemas, automatic
prompt caching. The model is `AGENT_MODEL` with `ANTHROPIC_API_KEY`;
without a key every agent run fails `agent_unavailable`. A run stops when
its submit tool accepts an answer, at `AGENT_TOKEN_BUDGET` tokens (every
token the provider reports; default 4,000,000) or `AGENT_MAX_TURNS` turns
(default 40), or when the model declines; the agent is told to submit at
80 % of either. No answer is `agent_incomplete`.

The agents read only through tools: `list_files`, `read_file` (numbered
lines, capped) and `search` (a literal, case-insensitive match, never a
model-supplied pattern) over an index of the extracted archive, so a path
outside it is refused. Text in the repository is data; the prompts say so,
and nothing an agent produces is used without a deterministic check and a
person's review. Logs are fixed lines (turn numbers, tool names and counts,
token totals); transcripts and tool results are never stored.

A `scope` run (`src/tools/scope.ts`) names a proposal, a spec revision (its
hash in the cache key) and the graphify run on its snapshot, and waits for
that run like a slice. It also names the snapshot's succeeded `abstractions`
and `data_model` runs when they exist (`abstractionsRunId`,
`dataModelRunId`; the bounty profiler queues the scope only once both have
finished), which give it `module_surface(path)`, `data_model(entity)` and,
when the abstractions run has a seams index, `module_seams(paths)`. A named
run that is gone, unfinished, on another snapshot or altered fails the run
`context_unavailable`. Besides the read tools it has `graph_neighbours`
and `check_scope`, which runs `analyseSlice`, the slice tool's own
computation, on a candidate at most eight times a run; `submit_scope`
is accepted only when slicing the submitted request again cuts every module
the agent called a seam. Output: `scope-proposal.json` (entry points with
reasons, budget, seams, summary, risks, the deterministic check of that
request and the token usage), also carried whole in its artifact row's
`meta`.

A `fixtures` run (`src/tools/fixtures.ts`) names a succeeded slice run, a
proposal and a spec revision, and `dataModelRunId` when the snapshot has
one. `check_fixtures` parses each implementation (exactly one function
expression that keeps the fixture rules of `packages/core/src/sandbox/confined.ts`,
which every build also applies, the walkthrough included), types it against the declaration it stands in for, and
compiles the walkthrough as `sandbox/run.ts` beside the included source
with the generated project's compiler options; `submit_fixtures` is
accepted only when that compiles. Output: `fixture-set.json` (fixtures with
reasons, the walkthrough, a summary and the token usage), also in `meta`. In
the project each fixture is its mock path's default behaviour
(`fixture(path, fn)` in `sandbox/mock.js`; `mockImplementation` overrides
it), the walkthrough is `sandbox/run.ts`, and every baseline runs
`npm run dev` after the build.

A sandbox's **preparation** (`src/tools/preparation.ts`) is a `fixtures` run
with `pseudonyms` in its parameters, queued by the API once a bounty's
profile is ready and its price approved and named on
`bounty_profile.prepared_run_id`. After the set it writes a name table,
checked as far as it can be without a version. Output, beside the set:
`pseudonym-table.json` (kind `pseudonyms`). A build given the run as
`preparedRunId` takes its fixtures and, when its own check passes it, its
table.

### Starter

A `sandbox_starter` run (`src/tools/starter.ts`) names a generated version
(`params.sandboxVersionId`), the approved task's hash and the stack it
follows; the API queues it from `POST /api/v1/orgs/:orgId/sandboxes/:id/starter`.
It reads no snapshot and the agent has no repository tools. It needs an
agent model (`agent_unavailable`) and an evaluation provider
(`evaluation_failed`), and fails `tool_failed` when the version is no longer
the draft of that task.

The agent writes a starter from the bounty's title, description, stack and
spec: source under `src/`, public tests that pass on it, hidden tests marked
with their expected baseline, exact package versions, the walkthrough and
its pseudonyms (`set_pseudonyms`; identifier and text rules only, at least
one, applied with the inverse proof to everything it wrote). `check_starter`
type-checks the project in memory, `run_starter` runs its baseline in a
fresh job and shows the agent the failing steps' output, and
`submit_starter` is accepted when the baseline passes. A public file, the
listing in the README and descriptor included, that still carries a
workspace name (`params.vocabulary`) fails the check as `vocabulary_leaked`
does a build. Once the runs are spent, the last answer is kept as a build
that is not ready. Outputs:
`starter-set.json` (the answer, its pseudonyms, the stack and the usage;
its hash is the version's `starterSha256`) and the same `build-manifest.json`,
`baseline.json`, `project/` and `private/` files a build writes. After the
run commits, the pseudonyms become the version's `aliasRules` and the
starter, its hidden tests, scope and transform are recorded on the draft
while it still points at the run.

## Sources are ephemeral

The fetcher sends the repository-scoped read token only to api.github.com
and follows a validated codeload redirect without Authorization. Archive
extraction validates paths, roots, member types, expanded size and file
count before writing; symlinks, hard links and device members are skipped,
never written. Parser processes receive a minimal environment with no
platform credentials. Logs contain fixed lifecycle messages and public
error codes; raw subprocess output is not stored. Artifacts and logs remain
private. Removing a repository or disconnecting an installation collects
its tree, artifact and log keys before the database cascade, fencing
concurrent writers; losing attempts remove their uploaded bytes, and
retrying a failed run removes its previous log. Download URLs expire after
15 minutes and responses containing them are not cached. Compose uses
`S3_PUBLIC_ENDPOINT` for browser links. Self-hosted S3 gateways disable
optional SDK checksum trailers (`packages/db/src/objects.ts`); artifact
SHA-256 hashes still cover the original files.

## Deployment order

The origin DNS service filter (`infra/lambda/origin_dns.py`,
`infra/discovery.tf`) must exclude worker and migration tasks before any
worker runs in the cluster; CD verifies the configured API service group
before registering worker revisions.

There is no worker service: the API launches Fargate tasks from the latest
ACTIVE task definition revision. A task polls (`WORKER_MODE=poll`), wakes on
the queue's `NOTIFY` (`analysis_run_queued`, `analysis_run_ended`) rather
than its five-second poll, and exits after `WORKER_IDLE_EXIT_MINUTES` (15)
without a run. Its connections carry `application_name`
`sandbox-factory-worker:<id>`, which is how the launcher counts the tasks
alive and sees an idle one. It starts another while the claimable and
running runs of a kind outnumber their slots (`queueState().short`), at
most two minutes apart and up to `WORKER_MAX_TASKS` (4). Terraform ignores
the worker's container definition after bootstrap, so an unrelated apply
cannot replace the latest image; container environment or secret-list
changes go through CD.

The worker's own dependencies are Zod for boot configuration,
`typescript-compiler` (an npm alias pinned to TypeScript 5.9.3) for its
compiler API and `libpg-query` for migration replay; the API adds the ECS SDK
to launch it.
