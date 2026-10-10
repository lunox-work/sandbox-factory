import type {
  BountyCategoryCountsDto,
  BountyCategoryMatch,
} from "@sandbox-factory/shared";
import { CATEGORIES, UNCATEGORIZED } from "sandbox-factory";

import { ALL_CATEGORIES, CategoryIcon } from "../../CategoryIcon";
import { FilterSelect } from "./FilterSelect";

export function CategoryLine({
  categories,
  lead,
  wrapOnPhone = false,
}: {
  categories: readonly BountyCategoryMatch[] | undefined;
  lead?: string | null;
  /**
   * Let the line wrap below the `sm` breakpoint. A proposal row stacks on a
   * phone and its title wraps, so a reason cut to "Deadline exposed ·…"
   * beside it would drop the one part worth reading.
   */
  wrapOnPhone?: boolean;
}) {
  const all = categories ?? [];
  const first = all.find(({ id }) => id === lead) ?? all[0];
  if (first === undefined) return null;
  const rest = all.filter((category) => category !== first);
  return (
    <span
      className={`text-muted-foreground block text-xs ${wrapOnPhone ? "sm:truncate" : "truncate"}`}
      data-testid="category-line"
      title={(categories ?? [])
        .map(({ label, reason }) => `${label}: ${reason}`)
        .join("\n")}
    >
      {/* Its icon and label in the category's colour, bare: the line sits
          in a row, and a pill would be a box inside it. */}
      <span className="category-label mr-0.5" data-category={first.id}>
        <CategoryIcon category={first.id} className="size-3 shrink-0" />
        {first.label}
      </span>{" "}
      {first.reason}
      {/* The others by their icons, each in its own colour; the title says
          what they are. */}
      {rest.length > 0 && (
        <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
          {rest.map((category) => (
            <span
              key={category.id}
              data-category={category.id}
              className="category-ink inline-flex"
            >
              <CategoryIcon category={category.id} className="size-3" />
            </span>
          ))}
          <span>+{rest.length} more</span>
        </span>
      )}
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
