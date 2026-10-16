import SandboxFactoryProofs.Aliases
import SandboxFactoryProofs.Handle

/-!
# Proofs about `packages/core`

Two theorems about rules in the dependency-free core, proved in Lean 4 over
models of the TypeScript. A model, not the code: each file says which
function it models, what it keeps and what it abstracts, and the law tests
in `packages/core/test` check the same statements against the real code.

- `Aliases`: a collision-free identifier rewrite is undone exactly by the
  inverse table, for every text and every rule list.
- `Handle`: a handle stem derived from any text passes `checkHandle`,
  whatever lowercasing does.
-/
