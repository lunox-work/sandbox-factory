# Roadmap

Status: proposals, 2026-10-15. Nothing here is built. The index of what is
built is [README.md](./README.md).

## Sandbox quality

A sandbox is useful in proportion to how well passing in it predicts passing
in the repository it came from. The scope agent now reads the abstractions
and data model in the bounty flow, and a sliced build writes its own
fixtures and walkthrough (see the worker contract). These come next, each
working only from what the platform already holds: the snapshot and the
context builders' runs on it, with no new repository permission and no
repository code executed outside an evaluation job.

### The repository's tests come along

**Selection, at slice time.** A test file the graph shows importing an
included file (an inbound cut whose importer `isTestFile`) is a candidate.
It is carried when every import it makes lands on an included file, a cut
module (which the project mocks) or a package, and it uses a runner the
project can run: `node:test`, or Vitest, including Jest-style globals with no
`jest.` API. The manifest lists each candidate with its runner, or why it was
not carried. The scope agent's `check_scope` reports how many tests a
candidate slice would carry, so it can prefer a cut the repository already
tests.

**In the project.** Carried tests keep their paths, are a path class of
their own, and run under `npm test` beside the generated public tests:
`node:test` ones as they do now, Vitest ones through `vitest run`, installed
at a pinned version only when a carried test needs it.

**Kept only when they pass.** A carried test that passes upstream can fail
here, because its collaborators are mocks. The baseline runs the carried
tests first, drops each that fails, and records why, so the public suite
passes on the unchanged project. The full suite still runs in the
repository's CI at merge-back (gate 3 below).

**Done when** the worker smoke fixture carries a `node:test` test and a
Vitest test, refuses one that imports past the slice, and drops one that
fails against a mock.

### Calls nobody gave behaviour

- The mock runtime marks a call that neither a fixture nor
  `mockImplementation` answered, and `recordedCalls()` says so.
- The baseline counts such calls during the walkthrough and the public
  tests, and the build manifest records them by mock path.
- The fixtures agent is shown that list on its next run, so its set covers
  the calls the code actually makes.
- Once a version's walkthrough and public tests make no such calls, the
  version can opt into strict mocks, where one throws.

**Done when** a build manifest lists the unfixtured calls its walkthrough
made, and a fixtures run given that list covers them.

### The repository's strictness

- **Real package types.** The baseline adds a second type check in which
  approved packages keep the types they install with rather than the
  ambient `any`. It reports, not blocks, until the error count is known
  across real slices; then it blocks.
- **The repository's compiler strictness.** `noImplicitAny` and the other
  strict options the slice's `tsconfig` sets are kept rather than turned
  off, once the second check shows the slice compiles with them.
- **The repository's lint rules.** When its ESLint configuration is a file
  in the snapshot and its plugins are registry packages, the project carries
  the configuration and runs it under `npm run lint`, in the evaluation job
  only.

**Done when** the baseline reports the real-types and lint findings for a
slice, and a slice whose repository compiles strictly builds strictly.

Order: the repository's tests first, the largest gain; then calls nobody gave
behaviour, which builds on the fixtures every sliced build now writes; then
strictness, measured best once merged pull requests can be replayed.

### More of the repository's model

The context builders cover TypeScript, JavaScript, Python, Go and Java
surfaces and Prisma, Drizzle and Postgres migration schemas. Still proposed,
each with a fixture: a syntactic tier for Rust, Kotlin, C#, Ruby and PHP; a
Python `typed` tier through `stubgen --parse-only`, which runs no code;
recognizers for TypeORM, Django, SQLAlchemy, Rails `schema.rb`, GORM, JPA and
Mongoose; and deterministic sample rows per entity that satisfy every foreign
key, which needs the build to generate a module fixtures may reference, since
a fixture is one function expression and cannot import. An ephemeral database
that runs the migrations was rejected for a builder: it executes repository
SQL, so it belongs in the evaluation provider if anywhere.

## Merge-back

### The goal

A contribution that passes in a sandbox becomes a pull request on the
repository it was sliced from, and passes that repository's own CI. A
version's source is already copied byte for byte at a pinned commit, and its
name table is proven to map back on the original text. Everything after the
contributor's change is missing.

### Three gates

A submission moves through three gates, each checking more than the one
before. Each is cheaper than the next and should predict it.

| Gate        | Where                                     | Checks                                                                               | Sees private names                                    |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 1. Public   | The contributor's VS Code                 | The public tests, `npm run build`, the walkthrough                                   | No                                                    |
| 2. Platform | A Lunox E2B container                     | The hidden tests, CodeQL, CodeRabbit, lint and type checks, on the patch mapped back | Yes; only counts reach the contributor                |
| 3. Upstream | The originating repository's pull request | That repository's own CI, whole                                                      | Yes; nothing reaches the contributor but pass or fail |

Gate 2 runs on the reversed patch, not the aliased one. If it checked the
aliased code, gate 3 would be the first place the reversed code ever
compiled, and a renaming or import-rewrite bug would surface in the
customer's pull request. Run after the reversal, gate 2 rehearses gate 3
inside the platform.

### What each gate needs

#### Gate 1: public

| Exists                                               | Missing                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The extension runs a task locally (`apps/extension`) | Extension sign-in                                                                                            |
| The descriptor names editable paths and public tests | A submit command and route: no route takes a submission (`packages/db/src/submissions.ts` is the shape only) |

How well gate 1 predicts gates 2 and 3 is the sandbox's own quality, which
[Sandbox quality](#sandbox-quality) works on.

#### Gate 2: platform

| Exists                                         | Missing                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submissionVerdict` and the `submission` table | An `e2b` evaluation provider. Only `local-process` exists, and `parseWorkerEnv` refuses `EVALUATION_PROVIDER=e2b`                                                                                                 |
| `invertAliasRules`, `renameFile`               | The reverse path: undo `importRewrites`, then the name table. New text the contributor wrote is refused when it holds a public or private name of any rule, since the inverse proof covers only the original text |
| `freezeReadiness` names a no-change round trip | The round-trip run: the unchanged project, mapped back, must equal the slice's included files byte for byte. `round_trip_run_id` is never written, and publishing does not call `freezeReadiness`                 |
| Hidden tests run on every build's baseline     | CodeQL, CodeRabbit and lint wired into the gate-2 job                                                                                                                                                             |
|                                                | The disclosure scan `freezeReadiness` names (`disclosure_run_id`)                                                                                                                                                 |

#### Gate 3: upstream

| Exists                                                 | Missing                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Read-only, repository-scoped tokens (`contents: read`) | Write access for a branch and a pull request (`contents: write`, `pull_requests: write`), asked for at merge-back time only |
|                                                        | Opening the pull request at the pinned commit, rebased onto the default branch                                              |
|                                                        | Reporting the repository's CI back to the submission, as pass or fail                                                       |
|                                                        | An integration agent for the small fixes a reversed patch needs upstream (below)                                            |
|                                                        | Hidden tests that also run upstream (below)                                                                                 |

### Supporting work

- **Integration agent rules.** A reversed patch can need small fixes
  upstream: a real type where the sandbox had `any`, a lint rule. The agent
  adds no `as any`, `!`, `@ts-ignore` or new `?.` at a call into a module
  past the cut, edits no test, keeps under a diff budget, and hands any
  choice of behaviour (a 404 or a throw) to a person. Its diff is a separate
  commit in the pull request, and its size is tracked: a large one means the
  slice was cut in the wrong place.
- **Hidden tests that run upstream.** Today they import `sandbox/mock.js`
  and the aliased paths, so they run only in the sandbox. Written against
  the task's interface through a thin seam layer, they bind the mocks in the
  sandbox and the repository's own fixtures upstream, and go into the pull
  request as its tests. A test that passes in the sandbox and fails upstream
  names the mock that was wrong.
- **Wider scope.** Sliced versions permit only `edit`
  (`resolveScope` in `packages/core/src/sandbox/provenance.ts`). Merge-back
  needs `add`, mapped back through path rules, and a governed request to
  change a seam ("add a method to this interface", "make this module
  editable"), which re-slices on approval.
- **Replaying merged pull requests.** Slice a merged pull request's parent
  commit for its ticket, apply the real diff in the sandbox, run the hidden
  tests, and map it back. This measures what nothing measures now: whether a
  slice contains the real fix's files, whether the hidden tests accept the
  real fix and refuse the parent, whether the reversed diff equals the real
  one byte for byte, and how often a gate-2 pass fails gate 3. It needs the
  reverse path, so it lands with gate 2.
- **Drift.** A version stays pinned to one commit. Re-slicing on a schedule,
  updating silently while the hidden tests still pass and flagging the
  company otherwise, can wait until contributors work in published versions.

### Open decisions

- **Who pays for a gate-3 failure** after gate 2 passed: the contributor,
  the integration agent, or the company. The concept splits the bounty
  between the hidden tests and acceptance; the three gates need the same
  decision.
- **What gate 2 reports.** Counts per check, as hidden tests do now, or
  CodeRabbit's review text after it is renamed to public names.
- **Write access.** Asked for when a workspace connects, or only when its
  first submission is accepted.

### Order

1. Submission intake, the reverse path and the round-trip run.
2. The `e2b` provider and the gate-2 checks; replaying merged pull requests.
3. Write access, the pull request and the integration agent.
4. Hidden tests that run upstream, wider scope, drift.
