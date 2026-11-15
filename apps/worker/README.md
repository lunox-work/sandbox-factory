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
from two checkout paths, and a slice of the resulting graph. It then runs
the round trip (`scripts/roundtrip.mjs`; on the host, `npm run worker:roundtrip`,
no Python needed): slice and build with pseudonyms, the contributor's npm
commands on `project/` alone, grading, the reversed check and carry-back; its
default build must hash to `GOLDEN_DIGEST`, `ROUNDTRIP_GENERATOR=carveout`
runs it on the carveout engine, `ROUNDTRIP_KEEP=1` keeps its folder. Unit tests
inject subprocesses and storage; real PostgreSQL tests exercise concurrent
claims, spend limits and stale leases.

## Run lifecycle

Runs are `analysis_run` rows cached by `(snapshot, tool, version, canonical
params hash)`; the same inputs are one run. Each attempt owns a unique lease
and storage prefix, so a late worker cannot overwrite its successor, and
completion inserts artifacts and changes status in one fenced transaction
(`packages/db/src/analysis-runs.ts`, modelled in `docs/specs/RunLease.tla`);
a grading run's verdict is written in that transaction too, and a grading
run that fails, or that the watchdog fails out of attempts, errors its
submission in the transaction that ends it.
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

### Grading

A `submission_grade` run (`src/tools/submission-grade.ts`) applies a
submission's files to the built version it names (`gradingTree`: refused
when it touches the version's own files) and runs the version's baseline on
the result in a fresh job, every hidden test expected to pass. duediligence's
`verdict` decides passed, overfit, incomplete or refused; the submission
records counts, that verdict and the scenario keys (`s1`, from the hidden
test's file name) of failing hidden tests, never a hidden test's name, body
or output. The verdict is handed to the run's commit (`settleSubmission`,
`RunSettlement`), never written before it: a lost lease or failed upload
leaves neither the verdict nor `private/merge-patch.json`, and the
submission `errored` once the run has ended. Its files are read from the key the submission row names;
guide and editor files and build output never reach it (the API drops them
before storing, `withoutGuideFiles`, `withoutBuildOutput`).
Before anything runs, carveout's `gainedIntegrity` refuses a file that
gains a way to pass without the code. On a version sliced from a
repository the run is on its snapshot, and a pass is carried back
(`reverseSubmission`) to `private/merge-patch.json`, or refused when it
cannot be, under the renaming the build was made with (`src/tools/engines.ts`:
carveout's when its manifest has `engines.carveout`, else `ALIASES_V1`).
The patch is kept only once `repositoryTree` (the version in the
repository's names with the carried files in place) passes the same
baseline in a second job, and only when the carry renamed no word the
contributor wrote by a pair learned from part of a text rule
(`carriedWordHazards`, checked first); otherwise the result is
`carryBack: "failed"` with no patch. A carry refused for the carry's own
limit (`carryLimitOf`: a new file at a path the repository holds outside
the slice, carveout's stranded name after 0.3.1) is `carryBack: "failed"`
too, not `refused`. A submission is `running` from the claim of its run.

A version's build manifest may record a `layout` (`GradingLayout`,
`packages/core/src/sandbox/layout.ts`); none is the platform's own
(`sandbox/`, `mocks/`, `tests/{public,private}`), so a version built before
layouts grades byte for byte as before. On another layout `gradingTree`
keeps its harness roots and configuration files, and the baseline runs in
two jobs (`runLayoutBaseline` in `src/tools/sandbox-build.ts`): the public
files with the layout's commands, then the public files with the hidden
tests, sealed after the build, each hidden test twice by `hiddenTestRun`.
Grading stages every `private/` artifact `stagedHiddenTest` names (a
TypeScript test file, never `pseudonym.lunox`), which is what the handout
counts and commits to.

Project generator (`src/tools/project-generator.ts`): `sandbox_build`
writes the project with core's `generateProject` unless the adapter is
created with `projectGenerator: "carveout"` (off by default, not wired to
an env var): carveout's `generateProject` (`carveout/api`), then
`platformLayers` (public names, fixture defaults, walkthrough,
`tests/public/spec.test.ts`, carried and hidden tests, source maps,
package version and npm pin, guide, descriptor, README). The manifest
records `engines.projectGenerator: "carveout"` and the layout
(`carveoutLayout`: carveout's harness, `carveout.env` and commands, the
platform's `tests/{public,private}`, `tests` a harness root); the build's
baseline runs in one job with carveout's commands (`ProjectRun`), grading
and the reversed check on the layout.

### Import

A `sandbox_import` run (`src/tools/sandbox-import.ts`, `sandbox_import@2`)
makes an uploaded carveout hand-off folder the draft its params name. It
reads the stored upload (`uploadObjectKey`, under the run's own workspace),
checks its hash and the record's (`carveout.json`), and writes the folder
verbatim under `project/`, the acceptance tests under `private/` at their
folder paths, `project/sandbox-task.json` (editable paths: the record's
included files that are not tests) and a `build-manifest.json` with the
file classes, the folder's layout (`carveout/api` `folderLayout`, plus the
descriptor), `engines.carveout` (the worker's release, which read the
layout) and `upload: { recordSha256, carveoutVersion }`. Its baseline runs
on that layout and every acceptance test must fail on it. After it, the
folder's public files are scanned beyond the names (`scanDisclosure`, with
`params.ticketKeys`): every finding is recorded in a `pending_acknowledgement`
gate (`acknowledgedAt: "publish"`), not a blocker, and no acknowledgement is
read, so publication checks the draft's list and the upload is never rebuilt;
the descriptor's title, summary and tags are redacted of every finding
(`redactDisclosure`). It calls no
model, reads no source, and records its build as a starter's
(`recordStarterOutput`): the import run is the version's starter and build.

### Slice

A slice run (`src/tools/slice.ts`) names the succeeded graphify run on the
same snapshot (`params.graphRunId`), its entry points (repository paths), a
budget (`maxFiles`, default 40; `maxDepth`, default 3) and
`includeInferred` (graphify's inferred edges; kept in the parameters, though
carveout's walk has none). A graph that did not succeed fails it
`graph_unavailable`; the graph names and hashes the request but chooses no
file. carveout analyses the slice (`slice/carveout-analysis.ts`,
`carveout/api` `analyse`, pinned exactly; its NOTICE.md lists where it
differs from the platform's analysis before it). The extractor, fixture
compile, compiler configuration, package types and registries the other
tools use are `carveout/extract`, at the same pin. carveout's analysis:
it walks the TypeScript compiler's resolution from the source, passing over
type-only imports and following a barrel only to the modules that supply
the names taken, until the budget is spent. Files inside are _included_,
imports that leave the set are _cuts_, and outside files' imports of
included modules are the _public surface_. The manifest records
`walkEngine: "carveout@<version>"`, no communities, and `toolVersion` with
the same release (`SLICE_TOOL_VERSION`); a literal path read at runtime
blocks nothing (`pathReads: "omit"`). An entry point the walk cannot read,
or a slice of no file, fails `tool_failed`; one past 64 MiB, `too_large`. For
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
(`packageRegistries` in `carveout/extract`).

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
values for every environment variable the slice reads, `README.md`,
`sandbox-task.json` and the contributor guide
(`packages/core/src/sandbox/guide.ts`: `TASK.md` with the renamed spec as
Gherkin and its confirmed decisions when both scans pass them
(`disclosableDecisions`) and the zipped-folder upload as the way to submit,
`AGENTS.md`, `CLAUDE.md`, `.vscode/`); it compiles with source maps
beside the emitted `.js`. The local contract is `npm ci`, `npm run dev`,
`npm run build`, `npm test` on Node 22+, fixed in `packages/core`. Only
registry versions are installed: a dependency pinned to a URL, a path or an
alias is `dependency_unresolved`. A package installs by its real name only
when a lockfile resolves it from the public registry and no configuration
sends its scope elsewhere; any other is mocked by default, and one from
another registry can never be approved. Every build scans the public files
for the workspace's names (`packages/core/src/sandbox/vocabulary.ts`; an
organization's distinctive words too, and the scope, or multi-word name, of each workspace or private-registry package the slice imports) and blocks `vocabulary_leaked`
on what carveout's scan or the platform's before it finds
(`src/tools/vocabulary-check.ts`), and for
credentials (`packages/core/src/sandbox/secrets.ts`) and blocks `secret_found`
by file, line and rule, never the value. Starters are scanned the same way.
`.gitignore` names only public files' output, and `*.map`. A starter's
project carries the same guide.

A slice requested with `carryTests` (new slices; `SliceParams`) has the
repository's own tests of it carried as read-only public tests under
`tests/public/carried/<renamed repository path>`
(`packages/core/src/sandbox/carried-tests.ts`): the walk's tests importing
the slice (`manifest.cuts.inbound`), `.test.ts(x)` on `node:test` whose
imports are Node modules, installed or mocked packages, slice files or
stubbed modules, at most `carriedTestLimits` (default 20 files, 256 KiB);
renamed by the table at their repository path, screened as public files,
then tried in a job of their own before the baseline (`trialCarriedTests`:
compiled with `noEmitOnError` off, each run twice with a 60 s limit). Only
those passing both runs are kept; the build manifest's `carriedTests`
records kept and dropped with the reason (`CARRIED_TEST_DROPS`), owners
only, and `buildSummary` its counts. A build with `carryTests: false` (an
owner's `POST …/sandboxes/:id/slice`, kept by the draft's later builds)
carries none, as does a slice without it. The reversed check puts each
back at `tests/public/carried/<repository path>` in the repository's names
(`repositoryTree`).

A sliced draft with no fixtures, hidden tests or pseudonyms has each written
by an agent during the build (`fixtures.ts` via `writeFixtures`,
`hidden-tests.ts`, `pseudonyms.ts`), kept only once its own check passes,
and settled on the draft when the run commits (`build-transform.json`; a
set written here names the build run as its `fixtureRunId`).
Hidden tests the agent wrote are then calibrated (`calibration.ts`, on
the pinned `duediligence/api`): a reference agent, told duediligence's
`prompts/repo/reference` brief, implements the bounty with the hidden tests
in view, and they run on it in a fresh job. A test expected to fail stays
only if `calibrate` keeps it (fails on the sandbox, passes on the
reference); a guard expected to pass stays only if the reference passes it.
A smaller set is run through its baseline again; none expected to fail left
is no set. The reference is never part of the version; the transform's
`hiddenTests.calibration` records the engine, kept, dropped with reasons,
the reference's paths and summary, and its usage.
The run's `decisionsSha256` names the spec's decisions a person confirmed
(`src/tools/decisions.ts` checks it against the frozen spec, else
`tool_failed`); both agents are then told them, renamed with the spec, as
"Decided, confirmed by the client" (the reference also in `spec.md`), and
the starter agent likewise. A run without it quotes none as confirmed.
A set an agent could not settle leaves the draft without, and the build
goes on. An older preparation run's set and table (`preparedRunId`, below)
are taken first.

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
Two providers ship, picked by `EVALUATION_PROVIDER`; the default, `none`,
fails every build `evaluation_failed` before anything is generated.

- `e2b` (`src/evaluation/e2b.ts`) is the hosted one: one fresh E2B sandbox
  per job from `E2B_TEMPLATE` (default `base`; it must have Node 22.12 or
  later, checked at creation, and no start command), killed on every path
  and alive at E2B for at most the job's budget
  (`E2B_JOB_TIMEOUT_SECONDS`, default 1,200) plus a minute. Commands run
  as the template's `user` with a fixed environment and the command's
  fixture values: no worker variable, credential or `E2B_API_KEY` enters
  the sandbox. Egress is `registry.npmjs.org` only (and the DNS server E2B
  opens beside it) while the trusted lockfile preparation and clean install
  run with scripts off, and is cut to nothing before any other command; a
  failed cut fails the job. The execution record's `egressCut` says
  whether it happened. Each command has its own timeout and output cap,
  then whatever the job's user left running is killed; a command cut
  short by the budget fails the job. The provider's own copies of the
  sealed tree run as root (below). The worker needs
  `E2B_API_KEY` with this provider and refuses to start without it.
- `local-process` (`src/evaluation/local-process.ts`): a temporary
  directory and child processes with a scrubbed environment. It is the
  development provider, **not an isolation boundary**, used only with
  `EVALUATION_PROVIDER=local-process` (the compose file sets it) and
  refused at startup with `NODE_ENV=production`.

Both providers seal a job after its build (`seal`,
`src/evaluation/hidden-runner.ts`): every hidden test's files leave the tree,
their text stays in the worker, and the tree is copied out of the job's reach
(root's in E2B, the worker's when local jobs run as their own uid). Each
hidden run (`EvaluationCommand.hidden`) starts from a fresh copy with its own
test alone, loaded from memory by the platform's runner
(`.sandbox-hidden/<name>.test.mjs`) before task code runs.

Outputs: `build-manifest.json` (every generated file hashed and classified
public or private; harness, test and project hashes; the toolchain and its
digest; `engines.carveout`, the release that renamed it, and
`engines.projectGenerator` when not the platform's generator; the evaluator
environment; import rewrites, renames, dependencies, blockers and the
baseline report; `gates`, the publication gates: `roundTrip`, the unchanged
project read back through the table at each file's repository path equal to
the slice's source but for the generator's specifier and `process.env`
edits, and no host or address text rule merge-back would learn words from
(`noChangeRoundTrip`, `carryHazards`; `not_applicable` for a starter or
upload), and
`disclosure`, the vocabulary and credential findings and the
`scanDisclosure` `findings` (each marked `acknowledged` as the build read
it), `total` and `acknowledged`; a starter's or upload's has
`acknowledgedAt: "publish"`, all findings and status
`pending_acknowledgement` when any, settled at publication; `hiddenCommitment`,
the handout's `hiddenSha256` version 2 over the hidden tests at their staged
paths, `hiddenCommitmentOf`), `baseline.json`, `project/<path>` for
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
80 % of either. No answer is `agent_incomplete`. Every turn's tokens are
written to the `model_usage` ledger against the run (`src/agent/metered.ts`),
which the API's monthly quota counts; nothing here stops a run for it.
Likewise every evaluation job a run creates writes its seconds to the
`evaluator_usage` ledger when torn down (`src/evaluation/metered.ts`),
which the API's monthly evaluator cap counts.

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

A sandbox's **preparation** (`src/tools/preparation.ts`) was a `fixtures`
run with `pseudonyms` in its parameters, queued by the API before 2026-10-19
and named on `bounty_profile.prepared_run_id`; nothing queues one now. Beside
the set it wrote `pseudonym-table.json` (kind `pseudonyms`). A build given
the run as `preparedRunId` still takes its fixtures and, when its own check
passes it, its table.

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
does a build, and so does any `scanDisclosure` finding (`params.ticketKeys`;
no acknowledgement is read, so the agent's files never depend on the
draft's list, and the final scan records what is left as pending, for
publication: `starterDisclosureGate`); the listing, spec and decisions are redacted
first, so the bounty's own links never fail it. Once the runs are spent, the last answer is kept as a build
that is not ready. An accepted answer's hidden tests are then calibrated
as a sliced build's are (`calibrateHiddenTests` with `hiddenTests:
"withheld"`): the reference agent reads the renamed project without them,
the spec and the confirmed decisions, its runs build the project and run
the walkthrough and public tests, and the hidden tests run once on the
reference it submits. Tests it fails are dropped (the set, project and
baseline keep the rest); none expected to fail left holds the build (not
ready, the baseline's reasons saying so, the agent's set kept as
diagnostic). Outputs:
`starter-set.json` (the answer, its pseudonyms, the stack and the usage;
its hash is the version's `starterSha256`), `build-transform.json` (the
hidden tests and `hiddenTests.calibration`, as a build's) and the same
`build-manifest.json`, `baseline.json`, `project/` and `private/` files a
build writes. After the
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

Hosted sandbox builds need the `e2b` evaluator, in this order:

1. Create an E2B account and an API key.
2. Build the template `sandbox-factory-node22` (Node 22, the default `user`,
   no start command) and check it end to end. `base`, the default, ships
   Node 20 (checked 2026-11-12), which a job refuses. The smoke asserts the
   baseline ran in E2B, its egress was cut and the sandbox was destroyed.

   ```sh
   E2B_API_KEY=… node apps/worker/scripts/e2b-template.mjs
   E2B_API_KEY=… E2B_TEMPLATE=sandbox-factory-node22 \
     SMOKE_EVALUATION_PROVIDER=e2b npm run smoke --workspace @sandbox-factory/worker
   ```

3. `terraform apply` in `infra/`: it creates the `/sandbox-factory/e2b-api-key`
   parameter (worker only, never the API) and lets the task execution role
   read it.
4. Put the key there, read from a file rather than the command line:
   `aws ssm put-parameter --overwrite --type SecureString --name /sandbox-factory/e2b-api-key --value file://<path>`.
5. Set the repository variables `WORKER_EVALUATION_PROVIDER=e2b` and
   `WORKER_E2B_TEMPLATE=sandbox-factory-node22`, then deploy: CD
   registers the worker revision with `EVALUATION_PROVIDER`, `E2B_TEMPLATE`
   and the key. `none` turns builds off again; unset keeps the latest
   revision's settings.

The worker's own dependencies are Zod for boot configuration,
`typescript-compiler` (an npm alias pinned to TypeScript 5.9.3) for its
compiler API, `libpg-query` for migration replay and `e2b` (pinned) for the
hosted evaluator; the API adds the ECS SDK to launch it.
