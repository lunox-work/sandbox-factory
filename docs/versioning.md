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

Release artifacts and every deployed image carry a **signed provenance
attestation**, which is the part that is actually verifiable:

```bash
# Everything the live site is serving, checked end to end
./scripts/verify-production.sh

# The running API image, by digest — pulled from the public mirror and re-hashed
gh attestation verify "oci://ghcr.io/lunox-work/sandbox-factory-api@$(
  curl -s https://platform.lunox.work/version | jq -r .imageDigest)" \
  --repo lunox-work/sandbox-factory \
  --signer-workflow lunox-work/sandbox-factory/.github/workflows/cd.yml \
  --source-ref refs/heads/main

# Any file the CDN served you
curl -sO https://platform.lunox.work/index.html
gh attestation verify index.html --repo lunox-work/sandbox-factory
```

## Identification is not proof

**The version string identifies.** It is a label the build stamped into the
artifact — enough to answer "which build is this?" in a bug report or a
rollback decision. But the running code only repeats a string it was handed, so
whoever controls a build can put anything there.

**The attestation proves.** GitHub signs a statement — _this artifact, with this
digest, was built by this workflow, from this commit_ — with a short-lived
certificate tied to the workflow's identity, and records it in a public
transparency log. Modifying the artifact breaks the signature even if the
version string inside still reads correctly.

Reproducible builds — the tier above, where independent parties rebuild
byte-identical artifacts — are deliberately not attempted. The deploy
pipeline's shared `cache-from: type=gha` alone rules them out.

## What the running server proves about itself

An attestation over an artifact answers "did these bytes come from that
commit?", not "is the server in front of me running them?". `GET /version`
closes that gap with one field:

```json
{
  "version": "1.0.0",
  "gitSha": "7456ae4d193c3fba378284075d9a2980f6ff585d",
  "imageDigest": "sha256:..."
}
```

Everything except `imageDigest` is a build-time claim. `imageDigest` is read at
boot by `apps/api/src/image-digest.ts` from `ECS_CONTAINER_METADATA_URI_V4`, an
endpoint served by the ECS agent describing the container as the _host_ sees
it. It names the bytes actually executing, and no build step gets to choose it.

| Step                                   | What it proves                          |
| -------------------------------------- | --------------------------------------- |
| `GET /version` → `gitSha`              | a claim                                 |
| `GET /version` → `imageDigest`         | the bytes this process is running       |
| `gh attestation verify oci://…`        | which workflow and commit produced them |
| `gh attestation verify <file>`         | the same, for each file the CDN served  |
| `ecs:DescribeTasks` via the audit role | the running digest, according to AWS    |

`scripts/verify-production.sh` walks all of it against the live site.

**The image is public.** Production runs it from a private ECR repository, and
cd.yml pushes the same build to `ghcr.io/lunox-work/sandbox-factory-api` in the
same step, so both registries hold one manifest with one digest. The mirror
exists only so an outsider has something to pull — `verify` re-hashes what it
pulls, and `gh api` alone would hand back the signed statement without checking
its signature. A deploy fails if the mirror's digest is not what is about to
run. `--signer-workflow` and `--source-ref` both matter: without them, an
attestation from any workflow on any branch of this repository would satisfy
the check.

**The SPA is verified per file.** cd.yml hands `attest-build-provenance` a
checksum list covering every file in `dist`, so each is a subject of one signed
statement and anyone can check what they were actually served.
The script verifies `index.html`, reads the file list out of the statement it
just verified, then downloads each file and compares hashes — so a file the CDN
omits is noticed too. Subresource integrity was considered and rejected: SRI
attributes live in `index.html`, served from the same bucket as the assets, so
whoever can alter an asset can alter the attribute vouching for it.

### Asking AWS instead

The weak link is the first row: `imageDigest` is reported by the server whose
identity is in question. That catches a stale or mismatched deployment, which is
the realistic failure, but a server replaced wholesale could report an honest
digest.

`infra/audit.tf` defines a role **any AWS account may assume** to read the
running digest from the ECS control plane, so the answer comes from AWS and this
project is out of the chain:

```bash
AUDIT_ROLE_ARN=arn:aws:iam::…:role/sandbox-factory-public-audit \
  ./scripts/verify-production.sh --aws
```

Three read-only calls — `ecs:ListTasks` and `ecs:DescribeTasks` on this one
cluster, `ecr:DescribeImages` on the one repository — with an explicit deny on
everything else. `ecs:DescribeTaskDefinition` is excluded deliberately: the task
definition carries `ORIGIN_VERIFY` in plain text. It is off by default
(`audit_role_public = false`), since a role with a `*` principal is not
something to enable by accident; the ARN belongs in `SECURITY.md` once it is on.

### What the environment can change

The attestation covers the image, not the environment it was started with.
`apps/api/src/env.ts` and `apps/worker/src/env.ts` list every variable each
reads, with its default and what it bounds; `apps/api/test/env-surface.test.ts`
pins the API's list, so widening it is a reviewed change. None of them enables
request logging.

### Limits worth stating plainly

- **Builds are not reproducible.** The link from source to digest rests on
  trusting GitHub Actions and Sigstore. `cache-from: type=gha` rules
  reproducibility out on its own: a shared mutable cache and byte-identical
  rebuilds are incompatible.
- **A targeted `index.html` is not detectable by its target alone.** We serve
  the document, so one specific visitor could be handed something else. They
  would find out only by running the verification above; nothing warns them.
- **Operations are not attested.** The code shows what enters the database. It
  cannot show who queried it afterwards, or where a backup went. That is what a
  DPA and an outside auditor are for, not a signature.
- **A rollback ships an unsigned SPA.** A `workflow_dispatch` with a `sha`
  builds a commit the attestation would name wrongly, so cd.yml signs nothing in
  that run: the API reuses the image attested when that commit first deployed,
  and the web files go up unsigned. Verification then fails loudly rather than
  passing on a false statement. Deploy forward to restore it.

## What the footer says

A version names a release, not a build: the deployed artifact, the signed
tarball, the `.vsix` and the docs-only commit after a tag all report the
same version. The commit sha is the one field that identifies a build, so
it is what `sameBuild()` compares and what the attestation binds to. The
footer always links the commit; it links the release only when
`gitRef == releaseTag(version)`, which CD satisfies by compiling the tag it
is about to cut into the artifact, so a build that merely carries a version
never claims it shipped. The tag shape is `sandbox-factory-v1.0.0`, never
`v1.0.0`: `releaseTag()` in `packages/shared/src/build-info.ts` is the one
definition, pinned by a test, and `release.yml` once triggered on `v*` and
published a release with no artifacts.

Web and API are built from one commit but deployed as two artifacts, so the
footer can show a mismatch during a rolling deploy, in a tab holding an old
bundle, or after a partial rollback; it reports and does nothing, since the
state resolves on reload. An unidentified build on either side is not a
mismatch, so a local `docker compose up` stays quiet. A deployed instance
is usually not at `main`'s head, and that is healthy. Ask which build (the
sha), whether it is the latest release (the version against the tag list)
and whether it was built from this repository (the attestation).

## How it is wired

`scripts/build-info.mjs` is the single resolver. Environment first, then git —
CI knows its commit exactly, and a container has no `.git`.

It is plain JavaScript because it runs in a Vite config, an esbuild config, and
`node` in CI, all _before_ anything compiles TypeScript.
`scripts/build-info.d.mts` types it; the `.d.mts` extension is load-bearing,
since a `.d.ts` beside an `.mjs` is silently ignored and the import becomes
`any`.

| Surface   | Mechanism                         | When       |
| --------- | --------------------------------- | ---------- |
| Web       | Vite plugin, `virtual:build-info` | build time |
| Extension | esbuild `define`                  | build time |
| API       | `BUILD_*` environment             | runtime    |

**The web app uses a virtual module, not `define`.** `define` substitutes during
bundling, and the Vite dev server does not bundle — the identifier survived as
an undeclared global, and the footer read `0.0.0` for all of `npm run dev` while
the production build and every test stayed green. A module resolves the same
way in both modes. The extension keeps `define` because esbuild always bundles.

Browser and extension values are compiled in and frozen, which is what makes a
stale bundle report itself honestly. The API reads its environment at boot.

The contract — the schema, `formatVersion`, `commitUrl`, `releaseUrl`,
`sameBuild` — lives in `packages/shared/src/build-info.ts`, so all three
surfaces format and compare identically.

## Building with provenance

Local builds need nothing; they read git, and mark a dirty tree:
`1.4.2+7f3a9c1-dirty`. `-dirty` means the sha does **not** fully describe the
artifact — the first thing to check when a build behaves unlike its commit.

Image builds have no `.git`, so the values are passed in:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_VERSION="1.4.2" \
  --build-arg BUILD_REF="$(git rev-parse --abbrev-ref HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

Omitted, they resolve to `unknown` — correct for a local build, and a **release
blocker** in CI.

The dev containers (`make up`) mount the repo, `.git` included, but
`node:22-alpine` ships no git binary. The Makefile resolves the values on the
host and compose passes them in, which is why `make up` shows a sha and a bare
`docker compose up` does not.

## Guards

The failure mode is silence: a broken `define`, an undeclared turbo variable or
a renamed field stamps the artifact `unknown` and breaks nothing. So the guards
are explicit.

- **`build-info.mjs --require-identified`** exits non-zero when no sha resolved.
  The release workflow runs it before building.
- **CI rebuilds with an injected sha and greps the bundle for it.** The check
  above proves the _resolver_ saw a sha; this proves it reached the _artifact_.
- **`apps/web/test/build-injection.test.ts` drives Vite itself**, in dev and
  build modes, and asserts on what the dev server actually serves. The other
  web tests stub the record, so they say nothing about the plumbing — which is
  how the `define` bug shipped past a green suite.
- **`turbo.json` declares the `BUILD_*` vars.** Turbo's strict environment drops
  undeclared variables, and the sha must be part of the cache key, or turbo
  replays a bundle stamped with the wrong commit.

The API deliberately has **no** such guard. Its `BUILD_*` vars are optional,
unlike `DATABASE_URL`: refusing to boot over a missing sha would turn a
reporting gap into an outage. The guard belongs at build time, where it fails a
pipeline instead of a deployment.
