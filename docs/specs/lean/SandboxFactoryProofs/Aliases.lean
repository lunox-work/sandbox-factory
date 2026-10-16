/-!
# Alias reversibility

Models `applyAliases` in `packages/core/src/sandbox/aliases.ts` for rules
of kind `identifier` with no path scope, and proves what the runtime check
there asserts: applying the inverse table to the output gives the input
back.

## The model

A text is a list of tokens. The identifier pattern the code uses,
`(?<![A-Za-z0-9_$])name(?![A-Za-z0-9_$])`, matches exactly the maximal
identifier runs equal to `name`, and the replacement is itself an
identifier (validation refuses anything else), so the maximal runs of the
output are those of the input with the matched ones renamed. That is the
one abstraction: the regular expression over characters is read as
equality on tokens, and the proof is over any token type with decidable
equality.

- `rename a b` is one rule applied forward, `rename b a` the same rule
  undone.
- `forward` applies the rules in order; `inverse` applies the swapped rules
  in reverse order, which is what `invertAliasRules` builds.
- `CollisionFree` is the `target_collision` check as the code performs it:
  before each rule, its target must not occur in the text *as rewritten by
  the rules before it*.

## The result

`inverse_forward`: for every rule list and every text, if the collision
check passes at each step, the inverse gives the text back. Nothing else is
assumed: not `validateAliasRules`, not distinct sources or targets, not the
absence of chains. Validation refuses those for the table's sake, so a
contributor's import reads one name one way; reversibility needs only the
collision check. The runtime `irreversible` problem can therefore never be
reported for identifier rules, and `aliases-properties.test.ts` checks the
same statement against the TypeScript on generated inputs.

Rules of kind `text` match without token boundaries and are outside this
model; for them the runtime check is load-bearing.
-/

namespace SandboxFactoryProofs.Aliases

variable {α : Type} [DecidableEq α]

/-- One rule: `before` is renamed to `after`. -/
structure Rule (α : Type) where
  before : α
  after : α

/-- Every token equal to `a` becomes `b`. -/
def rename (a b : α) (xs : List α) : List α :=
  xs.map fun x => if x = a then b else x

/-- The rules applied in order, as the forward pass does. -/
def forward (rules : List (Rule α)) (xs : List α) : List α :=
  rules.foldl (fun xs r => rename r.before r.after xs) xs

/-- The inverse table: the rules reversed, each swapped. -/
def inverse (rules : List (Rule α)) (xs : List α) : List α :=
  rules.reverse.foldl (fun xs r => rename r.after r.before xs) xs

/--
The `target_collision` check, step by step: before a rule applies, its
target must not already occur in the text the earlier rules produced.
-/
def CollisionFree : List (Rule α) → List α → Prop
  | [], _ => True
  | r :: rs, xs => r.after ∉ xs ∧ CollisionFree rs (rename r.before r.after xs)

/-- Renaming `a` to `b` and back is the identity when `b` was not there. -/
theorem rename_rename (a b : α) (xs : List α) (h : b ∉ xs) :
    rename b a (rename a b xs) = xs := by
  induction xs with
  | nil => rfl
  | cons x xs ih =>
    rw [List.mem_cons, not_or] at h
    obtain ⟨hbx, hbxs⟩ := h
    have tail := ih hbxs
    simp only [rename, List.map_cons, List.map_map] at tail ⊢
    rw [tail]
    by_cases hxa : x = a
    · subst hxa
      simp
    · have hxb : x ≠ b := fun hxb => hbx hxb.symm
      simp [hxa, hxb]

/--
**The theorem.** A collision-free forward pass is undone exactly by the
inverse table, for every text and every rule list.
-/
theorem inverse_forward (rules : List (Rule α)) (xs : List α)
    (h : CollisionFree rules xs) : inverse rules (forward rules xs) = xs := by
  induction rules generalizing xs with
  | nil => rfl
  | cons r rs ih =>
    simp only [CollisionFree] at h
    obtain ⟨hr, hrs⟩ := h
    simp only [forward, inverse, List.foldl_cons, List.reverse_cons,
      List.foldl_append, List.foldl_nil] at ih ⊢
    rw [ih _ hrs]
    exact rename_rename _ _ _ hr

omit [DecidableEq α] in
/-- A map that moves some member of the list does not return the list. -/
theorem map_ne_self (f : α → α) (xs : List α) (b : α) (hb : b ∈ xs)
    (hf : f b ≠ b) : xs.map f ≠ xs := by
  intro heq
  induction xs with
  | nil => simp at hb
  | cons x xs ih =>
    rw [List.map_cons, List.cons.injEq] at heq
    rw [List.mem_cons] at hb
    rcases hb with rfl | hb
    · exact hf heq.1
    · exact ih hb heq.2

/--
The collision check is also necessary, one rule at a time: if the target
already occurs, the inverse cannot tell a renamed token from an original
one, and the round trip changes the text where the original stood.
-/
theorem not_inverse_of_collision (a b : α) (xs : List α) (hab : a ≠ b)
    (h : b ∈ xs) : rename b a (rename a b xs) ≠ xs := by
  have hcomp : rename b a (rename a b xs) =
      xs.map fun x => if (if x = a then b else x) = b then a else if x = a then b else x := by
    simp only [rename, List.map_map, Function.comp_def]
  rw [hcomp]
  apply map_ne_self _ _ b h
  have hba : b ≠ a := fun e => hab e.symm
  simpa [hba] using hab

end SandboxFactoryProofs.Aliases
