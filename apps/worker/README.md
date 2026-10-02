# Private repository analysis worker

Graphify is the only Phase 3 adapter. It analyzes an immutable repository
snapshot with `graphifyy==0.4.18`, pinned parser packages and NetworkX 3.4.2.
The worker does not execute repository code, install its dependencies or use an
LLM. DeepWiki Open and Archify remain candidates for later adapters.

## Run locally

Configure the GitHub App in `.env.development`, start dependencies, and apply
local database migrations with `make migrate`. `make up` starts the polling
worker alongside the API and web app. In GitHub settings, open a registered
repository's **Analysis** panel and choose **Analyse now**. Any organization
member can open artifacts; owners and admins can start runs and read logs.

`make worker-smoke` builds the production image and runs the real pipeline on
the checked-in fixture without GitHub, database or AWS credentials. It checks
archive validation, namespaced symbols, relative/directory/alias imports,
unresolved and dynamic imports, ignore rules, graph direction, artifact upload
and identical canonical graph facts from different checkout paths. Unit tests
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
