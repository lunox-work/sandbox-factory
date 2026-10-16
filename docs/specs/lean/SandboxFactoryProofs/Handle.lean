/-!
# Every handle stem is a valid handle

Models `toHandleStem` and `checkHandle` in `packages/core/src/handle.ts`
and proves the comment on `toHandleStem`: the result always passes
`checkHandle`, for any input text. `handle-properties.test.ts` checks the
same statement against the TypeScript on generated strings.

## The model

A string is a list of characters.

- `inCharset` is `HANDLE_PATTERN`'s class, `[a-z0-9_-]`.
- `sanitize` is `replace(/[^a-z0-9_-]+/g, "-")`: each maximal run of
  characters outside the class becomes one hyphen.
- `trimHyphens` drops leading and trailing hyphens.
- `toHandleStem lower` lowercases, sanitizes, trims, cuts to the maximum
  length, trims again, and pads or replaces a result that is too short.

Lowercasing is left abstract: `lower` is any function on characters. The
TypeScript's `toLowerCase` is Unicode-aware in ways no model of `Char`
reproduces (the Kelvin sign becomes `k`), and the theorem does not depend
on it, since `sanitize` turns everything outside the class into a hyphen
whatever `lower` did. That the proof goes through for every `lower` is the
point: the property rests on the sanitizing, not the casing.

## The result

`toHandleStem_valid`: `checkHandle (toHandleStem lower s) = true` for every
`lower` and every `s`.
-/

namespace SandboxFactoryProofs.Handle

/-- `HANDLE_PATTERN`'s class: lowercase letters, digits, hyphen, underscore. -/
def inCharset (c : Char) : Bool :=
  ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '_' || c == '-'

def minLength : Nat := 3
def maxLength : Nat := 30

/-- `checkHandle(handle).status === "ok"`. -/
def checkHandle (s : List Char) : Bool :=
  decide (minLength ≤ s.length) && decide (s.length ≤ maxLength) && s.all inCharset

/--
`replace(/[^a-z0-9_-]+/g, "-")`. The flag says whether the previous
character was outside the class, so a run emits one hyphen at its start.
-/
def sanitizeAux : Bool → List Char → List Char
  | _, [] => []
  | inRun, c :: cs =>
    if inCharset c then c :: sanitizeAux false cs
    else (if inRun then [] else ['-']) ++ sanitizeAux true cs

def sanitize (s : List Char) : List Char := sanitizeAux false s

def isHyphen (c : Char) : Bool := c == '-'

/-- Leading and trailing hyphens stripped. -/
def trimHyphens (s : List Char) : List Char :=
  ((s.dropWhile isHyphen).reverse.dropWhile isHyphen).reverse

def fallback : List Char := ['u', 's', 'e', 'r']

/-- `toHandleStem`, with lowercasing abstracted as `lower`. -/
def toHandleStem (lower : Char → Char) (s : List Char) : List Char :=
  let cleaned := trimHyphens ((trimHyphens (sanitize (s.map lower))).take maxLength)
  if cleaned = [] then fallback
  else if minLength ≤ cleaned.length then cleaned
  else cleaned ++ '-' :: fallback

theorem inCharset_hyphen : inCharset '-' = true := by decide

theorem mem_sanitizeAux (inRun : Bool) (s : List Char) (c : Char)
    (h : c ∈ sanitizeAux inRun s) : inCharset c = true := by
  induction s generalizing inRun with
  | nil => simp [sanitizeAux] at h
  | cons x xs ih =>
    simp only [sanitizeAux] at h
    split at h
    · rename_i hx
      rw [List.mem_cons] at h
      rcases h with rfl | h
      · exact hx
      · exact ih _ h
    · rw [List.mem_append] at h
      rcases h with h | h
      · split at h
        · simp at h
        · simp at h
          rw [h]
          exact inCharset_hyphen
      · exact ih _ h

theorem mem_sanitize (s : List Char) (c : Char) (h : c ∈ sanitize s) :
    inCharset c = true :=
  mem_sanitizeAux false s c h

theorem mem_of_mem_dropWhile (p : Char → Bool) (l : List Char) (c : Char)
    (h : c ∈ l.dropWhile p) : c ∈ l := by
  induction l with
  | nil => simp [List.dropWhile] at h
  | cons x xs ih =>
    simp only [List.dropWhile] at h
    split at h
    · exact List.mem_cons_of_mem _ (ih h)
    · exact h

theorem length_dropWhile_le' (p : Char → Bool) (l : List Char) :
    (l.dropWhile p).length ≤ l.length := by
  induction l with
  | nil => simp [List.dropWhile]
  | cons x xs ih =>
    simp only [List.dropWhile]
    split
    · exact Nat.le_succ_of_le ih
    · exact Nat.le_refl _

theorem mem_of_mem_trimHyphens (s : List Char) (c : Char)
    (h : c ∈ trimHyphens s) : c ∈ s := by
  unfold trimHyphens at h
  rw [List.mem_reverse] at h
  have h := mem_of_mem_dropWhile _ _ _ h
  rw [List.mem_reverse] at h
  exact mem_of_mem_dropWhile _ _ _ h

theorem length_trimHyphens_le (s : List Char) :
    (trimHyphens s).length ≤ s.length := by
  unfold trimHyphens
  rw [List.length_reverse]
  calc ((s.dropWhile isHyphen).reverse.dropWhile isHyphen).length
      ≤ (s.dropWhile isHyphen).reverse.length := length_dropWhile_le' _ _
    _ = (s.dropWhile isHyphen).length := List.length_reverse
    _ ≤ s.length := length_dropWhile_le' _ _

theorem all_fallback : ∀ c ∈ fallback, inCharset c = true := by decide

/-- **The theorem.** A stem from any text passes `checkHandle`. -/
theorem toHandleStem_valid (lower : Char → Char) (s : List Char) :
    checkHandle (toHandleStem lower s) = true := by
  unfold toHandleStem
  generalize hcl :
    trimHyphens ((trimHyphens (sanitize (s.map lower))).take maxLength) = cleaned
  have hmem : ∀ c ∈ cleaned, inCharset c = true := by
    intro c hc
    rw [← hcl] at hc
    exact mem_sanitize _ _
      (mem_of_mem_trimHyphens _ _
        (List.mem_of_mem_take (mem_of_mem_trimHyphens _ _ hc)))
  have hlen : cleaned.length ≤ maxLength := by
    rw [← hcl]
    exact Nat.le_trans (length_trimHyphens_le _) (List.length_take_le _ _)
  simp only [checkHandle, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true]
  split
  · decide
  · rename_i hne
    split
    · rename_i hmin
      exact ⟨⟨hmin, hlen⟩, hmem⟩
    · rename_i hshort
      have hpos : 0 < cleaned.length := by
        cases cleaned with
        | nil => exact absurd rfl hne
        | cons _ _ => simp
      refine ⟨⟨?_, ?_⟩, ?_⟩
      · simp only [List.length_append, List.length_cons, fallback, List.length_nil]
        unfold minLength
        omega
      · simp only [List.length_append, List.length_cons, fallback, List.length_nil]
        unfold minLength at hshort
        unfold maxLength
        omega
      · intro c hc
        rw [List.mem_append, List.mem_cons] at hc
        rcases hc with hc | rfl | hc
        · exact hmem c hc
        · exact inCharset_hyphen
        · exact all_fallback c hc

end SandboxFactoryProofs.Handle
