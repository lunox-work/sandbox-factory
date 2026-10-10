import type {
  BountyCategoryCountsDto,
  BountyCategoryMatch,
} from "@sandbox-factory/shared";
import { CATEGORIES, UNCATEGORIZED } from "sandbox-factory";

import { ALL_CATEGORIES, CategoryIcon } from "../../CategoryIcon";
import { FilterSelect } from "./FilterSelect";

/**
 * Why a backlog scan picked a bounty, as its row in the list leads with it:
 * the first category's icon, lit in its colour on a dark tile. What each category is
 * and why it fit is said on hover and to a screen reader; the row says the
 * reason itself under its title, where it differs from row to row.
 */
export function CategoryMark({
  categories,
}: {
  categories: readonly BountyCategoryMatch[] | undefined;
}) {
  const all = categories ?? [];
  const [first] = all;
  if (first === undefined) return null;
  const said = all.map(({ label, reason }) => `${label}: ${reason}`);
  return (
    <span
      data-testid="category-mark"
      data-category={first.id}
      className="category-badge grid size-8 shrink-0 place-items-center rounded-lg"
      title={said.join("\n")}
    >
      <CategoryIcon category={first.id} className="size-4" />
      <span className="sr-only">{said.join(". ")}</span>
    </span>
  );
}

interface CategoryEntry {
  id: string;
  label: string;
  why: string;
  count: number | undefined;
}

/**
 * What the list can be narrowed to: All, the six in registry order, and the
 * bounties in none, called "Unassigned". Each with how many it holds, once
 * the counts arrive. A bounty in two categories counts in both, which is why
 * the counts can sum past "All".
 */
function categoryEntries(
  counts: BountyCategoryCountsDto | undefined,
): CategoryEntry[] {
  return [
    {
      id: ALL_CATEGORIES,
      label: "All categories",
      why: "",
      count: counts?.total,
    },
    ...(counts?.categories ??
      CATEGORIES.map(({ id, label, why }) => ({
        id,
        label,
        why,
        count: undefined,
      }))),
    {
      id: UNCATEGORIZED,
      label: "Unassigned",
      why: "In no category: written here, picked by hand, or not in one on its board's last scan.",
      count: counts?.uncategorized,
    },
  ];
}

function chosenEntry(
  counts: BountyCategoryCountsDto | undefined,
  selected: string | null,
): CategoryEntry {
  const entries = categoryEntries(counts);
  return (
    entries.find(({ id }) => id === (selected ?? ALL_CATEGORIES)) ?? entries[0]!
  );
}

/**
 * The list's category filter. Each option wears its category's icon in its
 * colour, as its card in "What task do teams outsource?" does — All and
 * Unassigned in neutrals — and says how many it holds. One with none is
 * still listed, so the list keeps its order, but cannot be picked unless it
 * is the one shown.
 */
export function CategoryFilter({
  counts,
  selected,
  onSelect,
}: {
  counts: BountyCategoryCountsDto | undefined;
  /** A category's id, `UNCATEGORIZED`, or null for all of them. */
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const value = selected ?? ALL_CATEGORIES;
  const active = chosenEntry(counts, selected);
  return (
    <FilterSelect
      data-testid="category-filter"
      label="Category"
      searchPlaceholder="Search categories…"
      value={value}
      onValueChange={(next) => onSelect(next === ALL_CATEGORIES ? null : next)}
      options={categoryEntries(counts).map((entry) => ({
        value: entry.id,
        label: entry.label,
        icon: <CategoryGlyph category={entry.id} />,
        detail: entry.count === undefined ? undefined : String(entry.count),
        disabled: entry.count === 0 && entry.id !== value,
      }))}
      icon={<CategoryGlyph category={active.id} />}
      text={active.label}
      count={active.count}
      clearLabel="Show every category"
      onClear={selected === null ? undefined : () => onSelect(null)}
    />
  );
}

/** What the chosen category is for, where a tooltip would hide it. */
export function CategoryNote({
  counts,
  selected,
}: {
  counts: BountyCategoryCountsDto | undefined;
  selected: string | null;
}) {
  const active = chosenEntry(counts, selected);
  if (active.why === "") return null;
  return (
    <p
      className="text-muted-foreground flex items-start gap-2 text-xs"
      data-testid="category-why"
      data-category={active.id}
    >
      <CategoryGlyph category={active.id} />
      <span className="leading-snug">
        <span className="font-semibold text-[var(--category-text)]">
          {active.label}.
        </span>{" "}
        {active.why}
      </span>
    </p>
  );
}

/**
 * A category's icon in its colour. The colour is named on the icon itself,
 * since a list's items grey any icon that does not.
 */
function CategoryGlyph({ category }: { category: string }) {
  return (
    <span data-category={category} className="inline-flex shrink-0">
      <CategoryIcon
        category={category}
        className="size-3.5 text-[var(--category-accent)]"
      />
    </span>
  );
}
