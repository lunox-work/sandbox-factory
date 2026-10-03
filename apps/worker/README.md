# Private repository analysis worker

Five adapters run here. Graphify analyzes an immutable repository
snapshot with `graphifyy==0.4.18`, pinned parser packages and NetworkX 3.4.2.
Slice reads a graphify run's graph and the same source to describe
the files one task needs and their boundary. Sandbox build
turns a slice and a version's private transform into a runnable project and
checks its baseline in an evaluation job. Scope and fixtures are agent runs:
a model reads the source to propose a slice for a ticket, and to write
behaviour for a succeeded slice's mocked calls. Graphify, slice and the
agents never execute repository code or install its dependencies; the build
executes the generated project only inside the evaluation provider's job.
Only the agents call a model. DeepWiki Open and Archify remain candidates
for later adapters.

## Run locally

Configure the GitHub App in `.env.development`, start dependencies, and apply
local database migrations with `make migrate`. `make up` starts the polling
worker alongside the API and web app. In GitHub settings, open a registered
repository's **Analysis** panel and choose **Analyse now**. Any organization
member can open artifacts; owners and admins can start runs and read logs.

`make worker-smoke` builds the production image and runs the real pipeline on
the checked-in fixture without GitHub, database or AWS credentials. It checks
archive validation, namespaced symbols, relative/directory/alias imports,
unresolved and dynamic imports, ignore rules, graph direction, artifact upload,
identical canonical graph facts from different checkout paths, and a slice of
the resulting graph: deterministic stubs for the cut modules, blockers for
the unresolved and dynamic imports, and a clean slice of a leaf file. Unit tests
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
and contract, the transform (alias rules, dependency choices and hidden
tests) and the approved task. The API queues it from
`POST /api/v1/orgs/:orgId/sandboxes/versions/:id/build`; the worker reads
the version's private provenance owner-scoped, refuses a run whose hashes no
longer match the draft (`tool_failed`), a slice that is not a succeeded run
on the same snapshot or whose artifacts fail their hashes
(`slice_unavailable`), and source bytes that differ from the manifest
(`source_unavailable`).

The alias table is applied to the included source, the declaration stubs,
the contract's symbols and the approved spec with the inverse proof from
`packages/core/src/sandbox/aliases.ts`; a collision or an irreversible rule
is an `alias_failed` blocker and nothing is generated. The project generator
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
`npm ci`, `npm run build`, `npm run dev`, `npm test`, and each hidden test on its own. A
hidden test must do what its `expectedBaseline` says (a bug's acceptance
test fails before the fix); a build or harness failure is never accepted as
that baseline. The job is destroyed on every path and its execution record
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
lockfile, and `private/<path>` for hidden tests. `ready` is true only with
no blockers and a passing baseline. Equal inputs and a fixed clock give
byte-identical manifests, provided the registry resolves the trusted lock
the same way; the lockfile is recorded so a difference is visible.

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
count before writing. Symlinks and hard links are refused. Parser processes
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

A `fixtures` run names a succeeded slice run, a proposal and a spec
revision. Its `check_fixtures` tool parses each implementation (exactly one
function expression, so it cannot add statements to the runtime it is
spliced into), assigns it in a generated check file to the declared type of
the call it stands in for, read from the slice's stubs, and compiles the
walkthrough as `sandbox/run.ts` beside the included source, with the
generated project's compiler options, ambient declarations and mock
runtime types, in memory. `submit_fixtures` is accepted only when that
compiles. Output: `fixture-set.json` (fixtures with reasons, the
walkthrough, a summary and the token usage), also carried in `meta`.

A version copies a fixture set into its transform. The build aliases the
fixtures and the walkthrough with the version's rules, registers each
fixture as its mock path's default behaviour (`fixture(path, fn)` in
`sandbox/mock.js`; `mockImplementation` still overrides it and
`resetMocks` keeps it), writes the walkthrough as `sandbox/run.ts`, and
blocks on a fixture for a module the slice does not mock or a walkthrough
import that resolves to no generated file. Every baseline runs
`npm run dev` after the build, and a non-zero exit fails it.

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
packages, Zod for boot configuration and `typescript-compiler` (an npm alias
pinned to TypeScript 5.9.3) for its compiler API. The API adds the ECS SDK for
batch launch. The web app uses the existing typed client package.
