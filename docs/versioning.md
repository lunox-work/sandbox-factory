# Versioning and build provenance

How a running instance says which commit it came from, and how someone else
checks that the claim is true.

## The short version

Every surface reports `<version>+<short sha>` — `1.4.2+7f3a9c1`:

| Surface   | Where                                           |
| --------- | ----------------------------------------------- |
| Web app   | Footer on every screen, and the browser console |
| API       | `GET /version`, `GET /health`, and the boot log |
| Extension | `sandbox-factory: Show Version`, output channel |

Both release artifacts and every deployed image carry a **signed provenance
attestation**, which is the part that is actually verifiable:

```bash
# A release artifact, by file
gh attestation verify sandbox-factory-web-7f3a9c1.tar.gz \
  --repo lunox-work/sandbox-factory

# What production is running right now, by digest
gh attestation verify --digest "$(curl -s https://platform.lunox.work/version \
  | jq -r .imageDigest)" --repo lunox-work/sandbox-factory
```

## What is a version, and what is proof

These are different things, and conflating them is the mistake this document
exists to prevent.

**The version string identifies.** `1.4.2+7f3a9c1` is a label the build stamped
into the artifact. It is enough to answer "which build is this?" in a support
conversation, a bug report or a rollback decision — which is 95% of what anyone
needs. But the running code is only repeating a string it was handed, so anyone
who controls a build can put anything there. It is not evidence.

**The attestation proves.** At release time GitHub signs a statement — _this
artifact, with this digest, was built by this workflow, from this commit_ —
using a short-lived certificate tied to the workflow's identity, and records it
in a public transparency log. Modifying the artifact breaks the signature even
if the version string inside it still reads correctly. Nobody has to trust us,
or GitHub's word about us, to check it.

A third tier exists — reproducible builds, where independent parties rebuild
from source and get a byte-identical artifact. That is what Signal and Tor do,
and it is the right answer when users must distrust the operator. It is a large
ongoing commitment and deliberately not attempted here. The `cache-from:
type=gha` in the deploy pipeline is alone enough to rule it out: a shared
mutable build cache and byte-identical rebuilds are incompatible by design.

## What the running server proves about itself

An attestation over a release artifact answers "did these bytes come from that
commit?". It does not answer "is the server in front of me running them" — the
artifact is a file someone downloaded, and nothing ties it to the process
serving traffic.

`GET /version` closes that gap with one field:

```json
{
  "version": "1.0.0",
  "gitSha": "7456ae4d193c3fba378284075d9a2980f6ff585d",
  "imageDigest": "sha256:..."
}
```

Everything there except `imageDigest` is a claim. The values are injected at
build time and repeated back, so a build that wanted to lie could put anything
in them — including a `gitSha` naming a commit it was never built from.

`imageDigest` is different in kind. `apps/api/src/image-digest.ts` reads it at
boot from `ECS_CONTAINER_METADATA_URI_V4`, an endpoint served by the ECS agent
on the host describing the container as the _host_ sees it. The digest is the
one the runtime resolved when it pulled, so it names the bytes that are
actually executing rather than the bytes a build argument said should be.

That makes it checkable by someone who trusts none of this:

```bash
gh attestation verify --digest sha256:... --repo lunox-work/sandbox-factory
```

`--digest` resolves through the public transparency log and needs no access to
the registry — which matters, because the image lives in a private ECR
repository that an outside verifier cannot pull from. The chain that results:

| Step                           | What it proves                          |
| ------------------------------ | --------------------------------------- |
| `GET /version` → `gitSha`      | a claim                                 |
| `GET /version` → `imageDigest` | the bytes this process is running       |
| `gh attestation verify`        | which workflow and commit produced them |

Two honest limits remain. The digest is reported by the same server whose
identity is in question, so this defends against a stale or mismatched
deployment, not against a server that has been fully replaced — for that, read
the digest from ECS directly rather than from the API. And it covers the API
only: the SPA is a set of files on a CDN with no single digest, so the web
tier stays at tier 2.

## Why the sha and not the version

Version alone cannot identify a build:

- Release-please tags only when a release PR merges, so **every commit between
  two releases reports the same version**. A dozen different builds, one number.
- Conversely, during a rolling deploy two artifacts from the same commit can
  briefly report different versions.

The commit sha is the only field that identifies one build, which is why it is
what `sameBuild()` compares and what the attestation binds to.

## Which link the footer offers

Two, and they answer different questions:

- **The commit** (`/commit/<sha>`) — always present. It is the field that
  identifies this exact build, and it resolves for every build there is.
- **The release** (`/releases/tag/sandbox-factory-v1.0.0`) — only when this
  build _is_ a tagged release, which most builds are not.

The release page does show its commit, so it reaches the same place in one
more click. It is still the wrong thing to link _instead_: every commit between
two releases carries the previous release's version while not being that
release, so linking it to that release page would claim it shipped when it did
not — and for an untagged build there is no release page to link at all. The
commit stays primary; the release is offered alongside it when it exists.

Note the tag shape. `release-please-config.json` names `packages/core` as a
component, so tags are `sandbox-factory-v1.0.0`, never `v1.0.0`. This is not
cosmetic: `release.yml` triggered on `v*` until 2026-09-17 and therefore never
fired for a single release-please tag — `sandbox-factory-v1.0.0` was published
with no artifacts and no attestation, and nothing reported an error, because a
trigger that does not match simply does not run. `releaseTag()` in
`packages/shared/src/build-info.ts` is the one definition, with a test pinning
it.

## Why "is this the repo head?" is the wrong question

A deployed instance is usually **not** at `main`'s HEAD, and that is healthy —
HEAD is whatever merged most recently, not what anyone decided to ship. Three
answerable questions replace it:

| Question                    | Answered by                       |
| --------------------------- | --------------------------------- |
| Which build am I running?   | the sha, always                   |
| Is it the latest release?   | the version, against the tag list |
| Was it built from our repo? | the attestation                   |

## Web and API can legitimately differ

They are built from one commit but deployed as two artifacts, so they drift:

1. **Rolling deploys are not atomic** — one updates before the other.
2. **An open tab holds an old bundle.** The main one. `index.html` is
   `no-cache`, but only a _reload_ re-fetches it; a tab open for six hours is
   running whatever it loaded then.
3. **A partial rollback** moves one and not the other.

The footer shows a mismatch and does nothing about it. A reload prompt would
fire during every rolling deploy and train people to dismiss it, and the state
resolves itself on the next reload anyway.

An unidentified build on either side is _not_ a mismatch: the question becomes
unanswerable, not answered "no", so a local `docker compose up` stays quiet.

## How it is wired

`scripts/build-info.mjs` is the single resolver. Environment first, then git —
CI knows its commit exactly, and a container has no `.git` at all.

It is plain JavaScript because it runs in three places that cannot consume
TypeScript, all _before_ the build that would compile it: a Vite config, an
esbuild config, and `node` in CI. `scripts/build-info.d.mts` types it; the
`.d.mts` extension is load-bearing, since a `.d.ts` beside an `.mjs` is silently
ignored and the import resolves to `any`.

| Surface   | Mechanism                         | When       |
| --------- | --------------------------------- | ---------- |
| Web       | Vite plugin, `virtual:build-info` | build time |
| Extension | esbuild `define`                  | build time |
| API       | `BUILD_*` environment             | runtime    |

The web app uses a virtual module rather than `define`, which is the obvious
first choice and is **wrong for the dev server**: `define` substitutes during
bundling, and the dev server does not bundle — it transforms each module on
request and leaves the identifier alone. The result was an undeclared global,
`undefined` at runtime, and a footer reading `0.0.0` with no sha for the whole
of `npm run dev`, while the production build and every test stayed green. A
module is resolved the same way in both modes, so they cannot disagree.

The extension keeps `define` because esbuild always bundles — there is no
transform-only mode for that identifier to survive into.

The browser and the extension host have no environment to read, so their values
are compiled in and frozen — which is the property that makes a stale bundle
report itself honestly. The API is a Node process, so it simply reads its
environment at boot.

The contract itself — the schema, `formatVersion`, `commitUrl`, `releaseUrl`,
`sameBuild` — lives in `packages/shared/src/build-info.ts`, so all three
surfaces format and compare identically.

`imageDigest` is the one field not resolved by `build-info.mjs`. It cannot be:
it is a runtime property of the container, not a build-time fact, and the whole
point is that no build step gets to choose it.

## Building with provenance

Local builds need nothing; they read git, and mark a dirty tree:

```
1.4.2+7f3a9c1-dirty
```

`-dirty` means uncommitted changes were present, so the sha does **not** fully
describe the artifact. It is the first thing to check when a build behaves
unlike its commit.

The dev containers (`make up`) are a special case: the repo _is_ mounted, `.git`
included, but `node:22-alpine` ships no git binary — so the resolver inside
cannot read it and would report `unknown`. The Makefile resolves the values on
the host and compose passes them in, which is why `make up` shows a sha and
`docker compose up` on its own does not.

Containers have no `.git`, so the values are passed in:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_VERSION="1.4.2" \
  --build-arg BUILD_REF="$(git rev-parse --abbrev-ref HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

Omitted, they resolve to `unknown` — correct for a local build, and a **release
blocker** in CI.

## Guards

The failure mode here is silence: a broken `define`, an undeclared turbo
variable or a renamed field does not break the build, it just stamps the
artifact `unknown`, and nothing else notices. So the guards are explicit.

- **`build-info.mjs --require-identified`** exits non-zero when no sha resolved.
  The release workflow runs it before building.
- **CI rebuilds with an injected sha and greps the bundle for it.** The
  `--require-identified` check proves the _resolver_ saw a sha; this proves the
  sha reached the _artifact_. A broken `define` passes the first and fails this.
- **`apps/web/test/build-injection.test.ts` drives Vite itself**, in both dev
  and build modes, and asserts on the text the dev server actually serves. The
  other web tests stub the record, so they prove the UI renders what it is given
  and say nothing about whether the plumbing delivers it — which is exactly how
  the `define` bug above shipped past a green suite.
- **`turbo.json` declares the `BUILD_*` vars.** Two reasons, both discovered the
  hard way: turbo runs tasks in a strict environment, so an undeclared variable
  never reaches the task at all; and the sha is part of the cache key, or turbo
  would replay an older bundle and ship an artifact stamped with the wrong
  commit — the exact failure this mechanism exists to rule out.

The API deliberately has **no** such guard. Its `BUILD_*` vars are optional,
unlike `DATABASE_URL`: a missing sha means it cannot say which commit it is,
which is real but cosmetic, and refusing to boot over it would turn a reporting
gap into an outage. The guard belongs at build time, where it fails a pipeline
instead of a deployment.

## Verifying a release

```bash
# What the deployed API claims.
curl -s https://api.example.com/version

# Download the artifact for that sha from the release, then check the claim.
gh attestation verify sandbox-factory-web-7f3a9c1.tar.gz \
  --repo lunox-work/sandbox-factory
```

The second command checks the signature against Sigstore's transparency log and
prints the workflow and commit that produced it. It needs no credentials and no
trust in the person running it.
