# Formal specifications

Two kinds of model, each a claim about a named piece of the code:

- **TLA+** for the three places where correctness rests on how concurrent
  steps interleave, which no unit test on a fake store can exercise. TLC
  checks every reachable state of a small instance.
- **Lean 4** ([lean/](./lean/)) for two rules in `packages/core` whose
  inputs are unbounded strings, where the property tests in
  `packages/core/test` can only sample. A proof covers every input.

Neither verifies the TypeScript itself. Each file says what it models and
what it abstracts, and the law and property tests check the same statements
against the real code.

## TLA+

Each spec names the source it models and states, as invariants and
temporal properties, what that source promises.

| Spec                                       | Models                                                                                         | Checks                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [RunLease.tla](./RunLease.tla)             | `packages/db/src/analysis-runs.ts` claim, heartbeat, fenced writes, release, fail, failExpired | No write under a stale lease lands; at most one worker passes the fence; a crashed holder's run is reclaimed; an ended run is final; only the watchdog retries, and gives up at the last attempt |
| [JobLimit.tla](./JobLimit.tla)             | `apps/worker/src/evaluation/limit.ts`                                                          | Never more than `Max` jobs; every permit released once; an abort never takes another caller's turn; every waiter is served or aborts                                                             |
| [ProgressWriter.tla](./ProgressWriter.tla) | `apps/worker/src/progress.ts`                                                                  | One write out at a time; when settled, the run holds every step unless the last write failed; a write out and not stale carries every step                                                       |

`RunLease_Exclusive.cfg` is expected to **fail**. It checks that two
workers never execute the same run at once, which the fence does not
promise: a stalled holder and the worker that reclaimed its run both
execute until the stalled one's next guarded statement is refused. The
trace documents why a worker's side effects outside the database are keyed
by its lease token (`logs/<run>/<token>.log`).

The lease model also makes one assumption explicit that the code does not:
the fence compares `lease_expires_at` with the clock of the worker making
the call, while the watchdog uses the API's. `Skew` bounds the difference,
and the properties hold for any skew within it.

## Running TLC

The specs are not part of `npm test`, which must pass without Java. CI's
`Formal specs` job (`ci.yml`) checks them on every push and pull request;
locally, check them by hand when the code they model changes. RunLease
takes under a minute on a laptop, the others a second or two. With Java
installed:

```bash
curl -sLO https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
cd docs/specs
java -jar ../../tla2tools.jar -workers auto -deadlock -cleanup -config RunLease.cfg RunLease.tla
java -jar ../../tla2tools.jar -workers auto -deadlock -cleanup -config JobLimit.cfg JobLimit.tla
java -jar ../../tla2tools.jar -workers auto -deadlock -cleanup -config ProgressWriter.cfg ProgressWriter.tla
```

Without Java, a container does the same (the jar in `/tmp/tla`, this
directory mounted read-only, TLC's scratch files kept out of the tree):

```bash
docker run --rm -v /tmp/tla:/tla:ro -v "$PWD/docs/specs:/specs:ro" eclipse-temurin:17-jre \
  sh -c 'mkdir /work && cp /specs/*.tla /specs/*.cfg /work && cd /work && java -jar /tla/tla2tools.jar -workers auto -deadlock -cleanup -config RunLease.cfg RunLease.tla'
```

`-deadlock` turns deadlock checking off: a behaviour in which every caller
has finished is a terminal state, not a fault. `-cleanup` removes the
scratch files TLC writes under `states/` beside the specs (the folder
itself is left empty, and gitignored). A successful run ends with `Model
checking completed. No error has been found.`; a failed invariant prints
the trace that reaches it.

Last checked 2026-10-16 with TLC2 2.19 (the tla2tools.jar at the v1.7.4
release tag, the last stable release and the one CI pins; v1.8.0 is a
prerelease): RunLease 850,702 distinct states, JobLimit 129, ProgressWriter
66, all properties holding; `RunLease_Exclusive.cfg` fails at depth 5 as
intended.

## Lean proofs

| File                                                     | Models                                                                     | Proves                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Aliases.lean](./lean/SandboxFactoryProofs/Aliases.lean) | `applyAliases` in `packages/core/src/sandbox/aliases.ts`, identifier rules | `inverse_forward`: a rewrite that passes the collision check at every step is undone exactly by the inverse table, for every text and rule list. `not_inverse_of_collision`: the check is necessary |
| [Handle.lean](./lean/SandboxFactoryProofs/Handle.lean)   | `toHandleStem` and `checkHandle` in `packages/core/src/handle.ts`          | `toHandleStem_valid`: a stem from any text passes `checkHandle`, for any lowercasing function                                                                                                       |

Two things the proofs settle that sampling could not. Alias reversibility
needs only the per-step collision check: not `validateAliasRules`, not
distinct sources or targets, not the absence of chains. Validation refuses
those for the inverse table's sake, so a contributor's import reads one
name one way; the runtime `irreversible` problem can never fire for
identifier rules. And the handle stem law holds whatever `toLowerCase`
does, so the Kelvin-sign class of lookalikes cannot reach a stem.

What is abstracted: the alias model reads the identifier regular
expression as equality on tokens (its boundary assertions match exactly the
maximal identifier runs), and leaves rules of kind `text` and path scopes
out. The handle model takes lowercasing as an arbitrary function. Each file
states this at the top.

The proofs depend on `propext` and `Quot.sound` only, Lean's standard
axioms, and contain no `sorry`. [Audit.lean](./lean/Audit.lean) checks
that for every declaration under the project's namespace, so a theorem
added later is audited without being listed anywhere, and fails on
anything else, `sorryAx` included. To check them, install
[elan](https://github.com/leanprover/elan) and run:

```bash
cd docs/specs/lean
lake build
lake env lean Audit.lean
```

Without elan, a container with it does the same, with `.lake/` written
into this directory (it is gitignored):

```bash
docker run --rm -v "$PWD/docs/specs/lean:/proof" -w /proof \
  debian:bookworm-slim sh -c 'apt-get update -qq && apt-get install -qq -y curl ca-certificates git >/dev/null && curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --no-modify-path --default-toolchain none && ~/.elan/bin/lake build'
```

CI's `Formal specs` job builds them the same way and runs the same audit.
`lean-toolchain` pins the Lean version; `lake-manifest.json` is lake's
generated lockfile for a project with no dependencies, and Prettier is told
to leave it alone. Last checked 2026-10-16 with Lean 4.35.0.

## Keeping them honest

A spec is a claim about the code, so it moves with it. When the fence, the
watchdog's sweep, the limiter or the progress recorder changes, change the
matching action and re-run TLC before declaring done. When the alias
rewrite or the handle stem changes, change the model to match and re-run
`lake build`. The properties state what every caller relies on; weakening
one is a design decision, and belongs in the pull request.
