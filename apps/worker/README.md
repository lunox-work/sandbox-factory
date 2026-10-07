# Private repository analysis worker

Ten adapters run here. Graphify analyzes an immutable repository
snapshot with `graphifyy==0.4.18`, pinned parser packages and NetworkX 3.4.2.
Dependency-cruiser, deepwiki, abstractions and data model are the other
context builders: a module dependency cruise of the snapshot, a wiki
written by a self-hosted DeepWiki-Open service, every module's callable
surface, and the entities the repository stores with the modules that
touch them; the last two read graphify's map. Slice reads a graphify run's graph and the same
source to describe the files one task needs and their boundary. Sandbox
build turns a slice and a version's private transform into a runnable
project and checks its baseline in an evaluation job. Scope and fixtures
are agent runs: a model reads the source to propose a slice for a bounty,
and to write behaviour for a succeeded slice's mocked calls. Starter is the
one run with no repository: a model writes a generated version's project
from the bounty's own text, which is then built and checked like a slice's.
Graphify, dependency-cruiser, abstractions, data model, slice and the
agents never execute repository code or install its dependencies; the build and the starter
execute the generated project only inside the evaluation provider's job.
Only the agents call a model; deepwiki hands the repository to the
configured DeepWiki-Open service, which uses its own.

## Run locally

Configure the GitHub App in `.env.development`, start dependencies, and apply
local database migrations with `make migrate`. `make up` starts the polling
worker alongside the API and web app. Open a registered repository's page
and choose **Build** on a context builder. Any organization member can open
artifacts; owners and admins can start runs and read logs. A sandbox
build's artifacts, hidden tests among them, are owners' and admins' only.

`make worker-smoke` builds the production image and runs the real pipeline on
the checked-in fixture without GitHub, database or AWS credentials. It checks
archive validation, namespaced symbols, relative/directory/alias imports,
unresolved and dynamic imports, ignore rules, graph direction, artifact upload,
identical canonical graph facts from different checkout paths, a slice of
the resulting graph (deterministic stubs for the cut modules, blockers for
the unresolved and dynamic imports, and a clean slice of a leaf file), and
the same `abstractions.json` and `data-model.json` bytes from two checkout
paths, with the tree-sitter tier reading the polyglot fixture. Unit tests
inject subprocesses and storage; real PostgreSQL tests exercise concurrent
claims, spend limits and stale leases.

## Output contract

`graph.json` is the canonical, directed graph with parallel relations and
relative source paths. Module-qualified IDs preserve same-named exports.
TypeScript's compiler API resolves literal imports using the nearest tsconfig;
external, unresolved and nonliteral imports stay visible as dependency nodes
and omissions. Other languages retain Graphify's AST extraction and recorded
unresolved targets. This is structural evidence, not runtime reachability or
complete cross-language dependency resolution.

`graph.html`, `GRAPH_REPORT.md` and `wiki/*.md` are Graphify presentation views.
Their underlying simple graph can collapse parallel relations; use graph.json
for facts. The HTML view displays at most 5,000 nodes, selected deterministically
by degree. The full graph remains in JSON. Wiki pages are structural inventories,
and communities use neutral names. `manifest.json` records coverage, omissions,
counts, confidence and the canonical graph SHA-256. Timing fields are diagnostic
and do not participate in the graph digest.

### Context builders

`dependency_cruiser`, `deepwiki`, `abstractions` and `data_model` are the
other context builders, queued like graphify from
`POST .../repositories/:id/runs` with the builder's name as `tool`; their
parameters are graphify's plus a `builder` discriminator (and, for the two
that read the map, `graphRunId`). Each writes a `manifest.json` whose
`meta` is the summary the console reads (`dependencyCruiserSummarySchema`,
`deepwikiSummarySchema`, `abstractionsSummarySchema` and
`dataModelSummarySchema` in `packages/shared`).

**dependency_cruiser** runs `dependency-cruiser` 18.5.0 on a thread of its
own (an abort terminates it) over the extracted source: every module system,
TypeScript parsed by swc (the worker's own `@swc/core`, so production reads
`.ts` as development does) with pre-compilation dependencies, only modules
inside the snapshot, `node_modules`, `dist`, `build`, `vendor`,
`third_party` and `.git` excluded, no rule set, and none of the repository's own
`tsconfig`, Babel or webpack configuration, so nothing in the snapshot is
read as configuration or executed; the cruiser only parses. Outputs:
`dependency-cruiser.json` (the full cruise, kind `dependency_graph`),
`dependency-cruiser.dot` (the dot rendering, kind `dependency_dot`) and
`manifest.json`, whose summary holds counts (modules, dependencies,
circular, orphans, unresolved, external) and bounded, sorted lists: the 25
busiest modules by dependents plus dependencies, up to 20 distinct cycles,
50 orphans and 50 unresolved imports, with `truncated` saying whether any
list was cut. The snapshot carries no `node_modules`, so a package import
resolves to nothing; `external` counts every bare specifier (a package or
a `node:` built-in) whether or not it resolved, and `unresolved` only the
relative, absolute and `#` subpath imports that name no file. The same
snapshot gives the same summary.

**deepwiki** asks a self-hosted DeepWiki-Open service (`DEEPWIKI_OPEN_URL`;
`DEEPWIKI_OPEN_AUTH_CODE`, `DEEPWIKI_OPEN_PROVIDER` and
`DEEPWIKI_OPEN_MODEL` optional) for a wiki of the repository: it deletes
the service's cached wiki for the repository, submits a task with the
repository-scoped read token, polls the task until it completes, then reads
the cached wiki. Without a URL deepwiki runs fail with
`builder_unavailable`; a run with no repository fails `source_unavailable`.
The service clones the repository's **default branch** itself and reads
it with its own model; it does not read the worker's snapshot, so the wiki
may describe a newer commit than the run names. The summary records the
commit the run was asked for as `requestedCommitSha`. Outputs:
`wiki/<name>.md` for every page (kind `wiki_page`, at most 500, one per
page id), the name its id made file-safe, a long one cut to 100 characters
with a short hash, a repeated one suffixed `-2`, `-3`,
`wiki-structure.json` (kind `wiki_structure`, the raw structure with the
repository, provider and model) and `manifest.json`; both JSON artifacts
carry the summary (title, description, provider, model, pages with their
importance, file paths, related pages and artifact path, and sections).
Trust boundary: the repository read token is sent to the configured
DeepWiki-Open service, so that service must be a trusted deployment the
operator controls; the worker never logs the token, the URLs it is sent
in, or anything the service returns beyond fixed lifecycle lines.

Locally, `make deepwiki-up` starts such a service: the `deepwiki` compose
profile runs DeepWiki-Open with the configuration in `apps/worker/deepwiki/`
and an Ollama sidecar for its embeddings. DeepWiki-Open has no Anthropic
provider, so its LiteLLM provider is pointed at DeepSeek with the key sizing
already uses (`DEEPSEEK_API_KEY`), and `.env.development` sets
`DEEPWIKI_OPEN_URL=http://deepwiki:8001` and
`DEEPWIKI_OPEN_PROVIDER=litellm` for the worker. A worker started before
the profile needs a restart to read them. Indexing a repository embeds
every chunk through the sidecar, which runs on the CPU; an Ollama
installed on the host uses the GPU and is pointed at with
`DEEPWIKI_OLLAMA_HOST=http://host.docker.internal:11434` (pull
`nomic-embed-text` there first).

**abstractions** and **data_model** read graphify's map, as a slice does:
their parameters add the succeeded graphify run on the same snapshot
(`params.graphRunId`), which the API enqueues or finds first and which the
queue waits for. A graph that did not succeed fails them
`graph_unavailable`. Coverage is recorded per module or source, never
implied, and finding nothing is a success with empty output.

**abstractions** lists every module's callable surface: the graph's code
files, tests aside, each with its language, its importer count from the
graph and its exports (name, kind, signature with bodies elided, line, and
the types it names by symbol id or package specifier). An export takes the
graph's module-qualified symbol id when the graph has a node of its name at
its line (or the only one of its name in the file), otherwise
`symbol:<path>#<name>`, so the scope agent can move between the two. Three
tiers:

- `typed`: TypeScript and JavaScript, with the slice's declaration emitter
  and `filterDeclaration` asking for every name, one program per nearest
  `tsconfig.json` through the slice's bounded compiler host, in a worker
  thread so a long compile cannot hold the lease heartbeat. A project whose
  program would parse more than 2,000 repository files goes to the
  syntactic tier with a `program_too_large` omission. Package types are
  references by specifier, listed in `externals`.
- `syntactic`: Python, Go and Java (and a capped TypeScript project) with
  the tree-sitter grammars already pinned for graphify, by
  `python/abstractions.py` in the graphify venv. Signatures read as written;
  no type is resolved, so a reference is only to an export of the same
  module, or for Go and Java of the same package directory. Exported means:
  Python, `__all__` when declared, else module-level names without a
  leading `_` (public methods and `__init__` as `Class.method`); Go, an
  upper-case identifier (a method when it and its receiver are); Java,
  `public` or `protected` (an interface's members unless `private`).
- `names-only`: any other language graphify parses, and any module a tier
  could not read: the graph's symbol nodes, with no signature.

Outputs: `abstractions.json` (kind `abstraction_index`; modules sorted by
path, with both extractors' versions and the graph's SHA-256),
`abstractions.md` (kind `other`; the most imported modules first, at most
300 modules or 256 Ki characters) and `manifest.json`, whose summary
(`abstractionsSummarySchema`) holds counts by coverage and language, the 25
most imported modules with their export counts, the first 25 omissions and
`truncated`. A module lists at most 500 exports and a signature at most
8,000 characters; each cut is an omission. The same snapshot gives the same
bytes.

**data_model** reads the entities, fields, enums and relations a
repository stores, and the modules that touch them. A recognizer runs only
on its evidence, never on folder names:

- Prisma, on every `.prisma` file (as one schema, as Prisma merges them),
  read with a parser for the schema language written here, so no
  configuration is looked up: models and views, `@map`/`@@map`/`@@schema`,
  `@id`/`@@id`, `@unique`/`@@unique`, defaults, `@db.*` native types,
  enums, `@relation` foreign keys with their actions, and implicit
  many-to-many lists. `@@ignore`d models and fields are left out.
- Drizzle, on the files the graph shows importing `drizzle-orm/pg-core`,
  `mysql-core` or `sqlite-core`, read from their syntax: `pgTable`,
  `mysqlTable`, `sqliteTable` and `pgSchema(...).table`, column builders
  (through a local helper such as `const ts = (n) => timestamp(n, ...)`,
  and a spread of a constant object in the same file), chained modifiers,
  `.references(() => t.column, { onDelete })`, `pgEnum`, and the extra
  config's `primaryKey`, `unique`/`uniqueIndex().on` and `foreignKey`.
- SQL migrations, on the `.sql` files in the tree facts' migration
  directories and beside any Drizzle Kit `meta/_journal.json`, parsed with
  libpg-query (Postgres's own parser as WebAssembly, `libpg-query@18.1.5`)
  and replayed in the tool's order (the journal's, else natural filename
  order, rollbacks left out) on an in-memory catalog: `CREATE`/`ALTER`/
  `DROP`/`RENAME` of tables, columns, constraints, unique indexes and enum
  types. A `DO` block is opened only for the idempotent-DDL idiom (`BEGIN
<ddl> EXCEPTION WHEN duplicate_object THEN null; END`); functions,
  triggers, data statements and other blocks are skipped and counted as
  omissions per file. Nothing reaches a database.

When two sources define one table, the declared schema wins (Prisma, then
Drizzle, then migrations); the other counts it as `shadowed`, and its
relations into the table point at the winner. Accessors are the modules
that read or write entities: for Drizzle, the files the graph shows
importing a defining file (through re-exporting barrels, three deep) and
the names they take; for Prisma, the files that reach `@prisma/client` and
call a model's delegate or import its type; for any table, code whose query
strings name it after `FROM`, `JOIN`, `INTO` or `UPDATE`. They rank by
entities touched, then importers. Outputs: `data-model.json` (kind
`data_model`), `erd.mmd` (kind `erd_mermaid`, a Mermaid `erDiagram`) and
`manifest.json`; both JSON artifacts carry the summary
(`dataModelSummarySchema`): storage, sources, counts and bounded lists of
entities with their fields, enums, relations, accessors and omissions.

### Slice

A slice run names the succeeded graphify run on the same snapshot it reads
(`params.graphRunId`), its entry points (repository paths), a budget
(`maxFiles`, default 40; `maxDepth`, default 3) and whether graphify's
inferred edges are walked (`includeInferred`, default off). The API enqueues
the graphify run first when none exists; the queue hands a slice to a worker
only once that run has finished, and a graph that did not succeed fails the
slice as `graph_unavailable`.

`reach` (`packages/core/src/slice`) walks the graph breadth first from the
entry points over import, call, inheritance and use relations, in path order,
until the budget is spent. Files inside are _included_; dependency edges that
leave the set are _cuts_. For TypeScript and JavaScript the worker emits
declarations for every cut module with the compiler's own declaration
emitter, narrows them to the imported names and what those reference, and
follows their imports until the set closes. Outside files' imports of
included modules become the _public surface_, described the same way. The
included files and stubs are then type-checked together in memory, at their
repository paths, with the source's nearest `tsconfig.json`; packages and
Node's globals are declared untyped for that check, since nothing is
installed. Other languages get the manifest, the cut modules by name and
`stubCoverage: "names-only"`.

Outputs: `slice-manifest.json` (source commit, graph run and its SHA-256,
canonical parameters, every included file with Git blob id, SHA-256, mode
and size, every generated file apart from them, required build inputs,
cut edges, externals, blockers, the operation policy and the contract's
hash), `boundary-contract.json` (stubbed and public symbols with their
declarations, compilation result, blockers), `stubs/<path>.d.ts`,
`boundary.md`, `public-surface.md` (views of the contract) and
`abstract.md` (the touched communities' wiki pages). `stubCoverage` is
`full` only when every symbol has a declaration and the fixture compiled;
`partial` and `names-only` runs, and any blocker (unknown entry point,
unresolved or dynamic import, missing build input, incomplete declaration,
compile error), are diagnostic and cannot advance to publishing. Externals
are listed by import specifier and environment variable name; values are
never read. The same entry points and budget on the same commit are one run.

### Sandbox build

A `sandbox_build` run names a sandbox version (`params.sandboxVersionId`),
its slice run and every hash the output must bind to: the slice manifest
and contract, the transform (alias rules, dependency choices, hidden tests
and fixtures, with the starter's hash for a generated version) and the
approved task. The API queues it from
`POST /api/v1/orgs/:orgId/sandboxes/versions/:id/build`; the worker reads
the version's private provenance owner-scoped, refuses a run whose hashes no
longer match the draft, or whose draft's content no longer hashes to them
(`tool_failed`), a slice that is not a succeeded run
on the same snapshot or whose artifacts fail their hashes
(`slice_unavailable`), and source bytes that differ from the manifest
(`source_unavailable`).

The alias table is applied to the included source, the declaration stubs,
the contract's symbols, the approved spec and the fixtures with the inverse
proof from `packages/core/src/sandbox/aliases.ts`, paths included. The
contract, spec and fixtures are renamed value by value, never their keys,
and must still read as their schemas afterwards. A collision, an
irreversible rule or a broken value is an `alias_failed` blocker and nothing
is generated. The project generator
(`packages/core/src/sandbox/project.ts`) then writes: copied source at its
aliased paths with compiler-alias imports rewritten to relative paths and
recorded; every cut module as a `.d.ts` stub beside a generated `.js` whose
exports are recording mocks; each service package as a local `file:` mock
package under `mocks/`; the harness (`sandbox/mock.js`, the ambient
declarations the slice compiled against, `sandbox/run.ts`); public tests
under `tests/public` (the public-surface check and scenario skeletons from
the spec); the owner's hidden tests under `tests/private`; `package.json`
pinning the approved packages, `tsconfig.json`, `.nvmrc`, `.npmrc`,
`sandbox.env` with fixture values for every environment variable the slice
reads, `README.md` and the public descriptor `sandbox-task.json`. The local
contract is `npm ci`, `npm run dev`, `npm run build`, `npm test` on Node
22+, declared in the descriptor and fixed in `packages/core`.

The baseline runs in a fresh job from the evaluation provider: trusted
preparation pins the lockfile (`npm install --package-lock-only`), then
`npm ci`, `npm run build`, `npm run dev`, `npm test`, and each hidden test on its own,
reported as TAP. At least one hidden test must be expected to fail, and each
must do what its `expectedBaseline` says (a bug's acceptance test fails
before the fix); a build or harness failure is never accepted as that
baseline, and neither is a test file that fails before any test in it ran,
which is an error. The job is destroyed on every path and its execution record
(provider, job id, environment, input hash, state, teardown) is kept in the
report. The worker ships `local-process` (`src/evaluation/local-process.ts`):
a temporary directory and child processes with a scrubbed environment. It
is the development provider, **not an isolation boundary**, so a worker
uses it only with `EVALUATION_PROVIDER=local-process` (the compose file
sets it). The default, `none`, fails every build with `evaluation_failed`
before anything is generated. Hosted execution of untrusted contributor code
needs an isolated evaluation provider; none is implemented. The provider
contract is in
[`packages/core/src/sandbox/build.ts`](../../packages/core/src/sandbox/build.ts),
and every record names which provider ran. A succeeded, ready build records
its harness hash and toolchain digest on the draft after the run commits,
and only while the draft still points at that build.

Outputs: `build-manifest.json` (every generated file hashed and classified,
public or private; harness, public-test, private-test and public-project
hashes; the toolchain and its digest; the evaluator environment; import
rewrites, renames, dependencies, blockers and the baseline report),
`baseline.json`, `project/<path>` for every public file including the
lockfile, `private/<path>` for hidden tests, and `private/pseudonym.lunox`
(kind `pseudonyms`), the alias rules the public files were renamed by. The
public sandbox is `project/`; the private sandbox is the same files read
back through the inverse of that table, so a build makes both without
storing the project twice. `ready` is true only with
no blockers and a passing baseline. Equal inputs and a fixed clock give
manifests that differ only in the evaluation job's id in the execution
record, provided the registry resolves the trusted lock the same way; the
lockfile is recorded so a difference is visible. Only registry versions are
installed: a dependency pinned to a URL, a path or an alias is
`dependency_unresolved`.

Runs cache `(snapshot, tool, version, canonical params hash)`. Each attempt owns
a unique lease and storage prefix, so a late worker cannot overwrite its
successor. Completion inserts artifacts and changes status in one fenced
transaction. A heartbeat runs every 15 seconds, the lease lasts 60 seconds, and
the default deadline is 30 minutes. A watchdog retries lost workers twice;
manual retries share that limit. SIGTERM stops new claims and allows the current
run 60 seconds before cancellation and release.

Sources are ephemeral. The fetcher sends the repository-scoped read token only
to api.github.com and follows a validated codeload redirect without Authorization.
Archive extraction validates paths, roots, member types, expanded size and file
count before writing. Symlinks, hard links and device members are skipped,
never written, so a repository that keeps a link still has its files
analyzed. Parser processes
receive a minimal environment with no platform credentials. Logs contain fixed
lifecycle messages and public error codes; raw subprocess output is not stored.
Artifacts and logs remain private. Removing a repository or disconnecting an
installation collects its tree, artifact and log keys before the database
cascade, fencing concurrent snapshot and analysis writers. Losing attempts
remove their uploaded bytes. Retrying a failed run removes its previous log. Download URLs expire after 15 minutes and
API responses containing them are not cached. Compose uses `S3_PUBLIC_ENDPOINT`
for browser links, keeping its container-internal storage hostname separate.
Self-hosted S3 gateways disable optional SDK checksum trailers that older
SeaweedFS versions otherwise store as object bytes; artifact SHA-256 hashes still
cover the original files. AWS keeps its normal SDK checksum behavior.

### Scope and fixtures (agents)

Both are a manual tool loop (`src/agent/loop.ts`) over the Anthropic
Messages API: one streamed call per turn on the beta endpoint for the
server-side refusal fallback, adaptive thinking at high effort, strict tool
schemas and automatic prompt caching. The model is `AGENT_MODEL` with
`ANTHROPIC_API_KEY` (the key sizing uses); without a key every agent run
fails `agent_unavailable`. A run stops when its submit tool accepts an
answer, at `AGENT_TOKEN_BUDGET` tokens (every token the provider reports,
cached or not; default 4,000,000) or `AGENT_MAX_TURNS` turns (default 40),
or when the model declines; the agent is told to submit at 80 % of either.
No answer is `agent_incomplete`.

The agents read only through tools: `list_files`, `read_file` (numbered
lines, capped) and `search` (a literal, case-insensitive match, never a
model-supplied pattern) over an index of the extracted archive, so a path
outside it is refused before anything is read. Text in the repository is
data; the prompts say so, and nothing an agent produces is used without a
deterministic check and a person's review. Logs are fixed lines: turn
numbers, tool names and counts, token totals. Transcripts and tool results
are never stored.

A `scope` run names a proposal, a spec revision (its hash in the cache key)
and the graphify run on its snapshot, and waits for that run like a slice.
Besides the read tools it has `graph_neighbours` and `check_scope`, which
runs `analyseSlice` (the slice tool's own computation) on a candidate
request, at most eight times a run. `submit_scope` is accepted only when
slicing the submitted request again cuts every module the agent called a
seam. Output: `scope-proposal.json` (entry points with reasons, budget,
seams with kinds, summary, risks, the deterministic check of exactly that
request and the token usage), also carried whole in its artifact row's
`meta` for the console.

When the snapshot has a succeeded `abstractions` or `data_model` run at
queue time, the API names it in the scope run's parameters
(`abstractionsRunId`, `dataModelRunId`), so it joins the cache key, and the
agent also gets `module_surface(path)` (a module's exports and signatures:
what its stub declares if the slice cuts it) and `data_model(entity)` (the
storage, entities and accessors, or one entity's fields, enum values,
relations and accessors). The prompt lists the top accessors as where a
`database` seam belongs. Neither is required, and `check_scope` still
decides. A named run that is gone, unfinished, on another snapshot or
altered fails the run `context_unavailable`.

A `fixtures` run names a succeeded slice run, a proposal and a spec
revision. Its `check_fixtures` tool parses each implementation (exactly one
function expression, so it cannot add statements to the runtime it is
spliced into), assigns it in a generated check file to the declared type of
the call it stands in for, read from the slice's stubs, and compiles the
walkthrough as `sandbox/run.ts` beside the included source, with the
generated project's compiler options, ambient declarations and mock
runtime types, in memory. `submit_fixtures` is accepted only when that
compiles. With the snapshot's `data_model` run (`dataModelRunId`), the agent
also has `data_model`, so a fixture standing in for a `database` seam keeps
required fields, enum values and foreign keys across fixtures. Output: `fixture-set.json` (fixtures with reasons, the
walkthrough, a summary and the token usage), also carried in `meta`.

A version copies a fixture set into its transform. The build aliases the
fixtures and the walkthrough with the version's rules, registers each
fixture as its mock path's default behaviour (`fixture(path, fn)` in
`sandbox/mock.js`; `mockImplementation` still overrides it and
`resetMocks` keeps it), writes the walkthrough as `sandbox/run.ts`, and
blocks on a fixture for a module the slice does not mock or a walkthrough
import that resolves to no generated file. Every baseline runs
`npm run dev` after the build, and a non-zero exit fails it.

### Starter

A `sandbox_starter` run names a generated version (`params.sandboxVersionId`),
the approved task's hash and the stack it follows; the API queues it from
`POST /api/v1/orgs/:orgId/sandboxes/:id/starter`. It reads no snapshot, so no
source is fetched and the agent has no repository tools. It needs both an
agent model (`agent_unavailable` otherwise) and an evaluation provider
(`evaluation_failed`), and fails `tool_failed` when the version is no longer
the draft of that task.

The agent writes a starter from the bounty's title, description, stack and,
when its proposal has one, Gherkin spec: source under `src/`, public tests
that pass on it, hidden tests marked with their expected baseline, exact
package versions, the walkthrough and its pseudonyms. The starter is
written in the bounty's own vocabulary, and the pseudonyms (`aliases`,
identifier and text rules only, at least one), set with `set_pseudonyms`
and applied by every other starter tool, rename it as a slice's alias table
does: applied with the inverse proof to the source, both suites, the
walkthrough and the spec, refusing a rule that renames nothing. The project
is generated from the renamed starter. `set_pseudonyms` is the one tool sent
without a strict schema: with the table in them, the three starter tools'
strict schemas compile past the Messages API's grammar limit, so its input
is checked when it runs. `check_starter` type-checks the project in memory
as `npm run build` would, and `run_starter` runs its baseline in a fresh
evaluation job and shows the agent each step and the output of the failing
ones, since nothing in a starter is client code. `submit_starter` runs it
once more and is accepted when the baseline passes; once the runs are
spent, the last answer is kept as a build that is
not ready. Logs stay fixed lines.

Outputs: `starter-set.json` (the answer as written, its pseudonyms, the
stack and the usage; its hash is the version's `starterSha256`) and the same `build-manifest.json`,
`baseline.json`, `project/` and `private/` files a build writes, the
manifest naming the starter where a build names its slice. After the run
commits, the starter, its pseudonyms as the version's `aliasRules`, its
hidden tests renamed as the build ran them, scope and transform, and a ready
build's harness and toolchain are recorded on the draft while it still
points at the run.

## Deployment order

Apply the origin DNS service filter in `infra/lambda/origin_dns.py` and
`infra/discovery.tf` before running any worker in the cluster. Ship that
prerequisite separately when preparing PRs. Both scheduled discovery and ECS
state events must exclude worker and migration tasks. CD verifies the configured
API service group before registering worker revisions.

Apply the worker ECR repository, egress-only security group, task role, task
definition and API launcher settings. Then CD builds and pushes the worker,
registers a revision, runs database migrations and updates the API. There is no
worker service: the API launches Fargate batches using the latest ACTIVE family
revision. Terraform ignores the worker's container definition after bootstrap,
so an unrelated apply cannot replace the latest worker image with bootstrap.
Container environment or secret-list changes must be applied to the active
revision through CD when that list changes.

Dependencies added here: the worker uses the existing DB/GitHub/shared/core
packages, Zod for boot configuration, `typescript-compiler` (an npm alias
pinned to TypeScript 5.9.3) for its compiler API and `@swc/core`, which
dependency-cruiser parses TypeScript with. The API adds the ECS SDK for
batch launch. The web app uses the existing typed client package.
