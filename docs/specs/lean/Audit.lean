import Lean
import SandboxFactoryProofs

/-!
# Axiom audit

Prints the axioms of every declaration under `SandboxFactoryProofs` and
fails if any rests on something beyond Lean's two standard axioms,
`propext` and `Quot.sound`. That also catches `sorry` (`sorryAx`) and
`native_decide` (`Lean.ofReduceBool`), and it covers a theorem added later
without anyone listing it. Not part of the library, so `lake build` leaves
it alone; run it from this directory, after `lake build`, with

    lake env lean Audit.lean

CI's `Formal specs` job does the same.
-/

open Lean Elab Command

run_cmd do
  let env ← getEnv
  let allowed : Array Name := #[``propext, ``Quot.sound]
  let mut theorems : Nat := 0
  let mut bad : Array MessageData := #[]
  for (name, info) in env.constants.toList do
    unless (`SandboxFactoryProofs).isPrefixOf name do continue
    let axioms ← collectAxioms name
    if let .thmInfo _ := info then
      unless name.isInternal do
        theorems := theorems + 1
        logInfo m!"{name}: {axioms}"
    for ax in axioms do
      unless allowed.contains ax do
        bad := bad.push m!"{name} depends on {ax}"
  if theorems == 0 then
    throwError "no theorems found under SandboxFactoryProofs"
  unless bad.isEmpty do
    throwError m!"axioms beyond propext and Quot.sound:\n{MessageData.joinSep bad.toList "\n"}"
  logInfo m!"{theorems} theorems audited: only propext and Quot.sound"
