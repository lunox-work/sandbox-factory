import type {
  BountyCategoryCountsDto,
  BountyCategoryMatch,
} from "@sandbox-factory/shared";
import { CATEGORIES, UNCATEGORIZED } from "sandbox-factory";

import { cn } from "@/lib/utils";

import { ALL_CATEGORIES, CategoryIcon } from "../../CategoryIcon";

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
      {/* A pill in the category's colour, as its card and its chip are. */}
      <span className="category-pill mr-0.5" data-category={first.id}>
        <CategoryIcon category={first.id} className="size-3 shrink-0" />
        {first.label}
      </span>{" "}
      {first.reason}
      {/* The others by their icons, each in its own colour; the title says
          what they are. */}
      {rest.length > 0 && (
        <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle">
          {rest.map((category) => (
            <span
              key={category.id}
              data-category={category.id}
              className="category-chip inline-grid size-4 place-items-center rounded-[4px]"
            >
              <CategoryIcon category={category.id} className="size-2.5" />
            </span>
          ))}
          <span className="ml-0.5">+{rest.length} more</span>
        </span>
      )}
    </span>
  );
}

/**
 * The bounties by the category their board's scan found them in, as one
 * row of chips above the list: All, the six in registry order, and the
 * bounties in none, called "Unassigned". Each wears its category's icon and
 * colour, as its card in "What task do teams outsource?" does — All and
 * Unassigned in neutrals — and pressed is washed in that colour. Each says
 * how many it holds, and pressed narrows the list to them. A chip with none is still there, dimmed,
 * so no chip moves when a count reaches zero; it is pressable only while it
 * is the one shown, to be left.
 *
 * A bounty in two categories counts in both, which is why the chips can sum
 * past "All". Until the counts arrive the chips are drawn without them.
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
  const chips: {
    id: string | null;
    label: string;
    why: string;
    count: number | undefined;
  }[] = [
    { id: null, label: "All", why: "", count: counts?.total },
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
  const active = chips.find(({ id }) => id === selected);
  return (
    <nav
      aria-label="Bounties by category"
      className="flex flex-col gap-2"
      data-testid="category-filter"
    >
      <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        {chips.map((chip) => {
          const pressed = chip.id === selected;
          const empty = chip.count === 0;
          return (
            <li
              key={chip.id ?? ALL_CATEGORIES}
              className="shrink-0"
              data-category={chip.id ?? ALL_CATEGORIES}
            >
              <button
                type="button"
                aria-pressed={pressed}
                disabled={empty && !pressed}
                title={chip.why === "" ? undefined : chip.why}
                onClick={() => onSelect(pressed ? null : chip.id)}
                className={cn(
                  "category-filter-chip bg-card focus-visible:ring-ring/50 inline-flex h-8 items-center gap-1.5 rounded-full border pr-1.5 pl-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
                  pressed ? "font-medium" : "text-muted-foreground",
                  chip.count === undefined && "pr-3",
                )}
              >
                {/* The tile its card in the dialog has, made round. */}
                <span className="category-chip grid size-6 shrink-0 place-items-center rounded-full">
                  <CategoryIcon
                    category={chip.id ?? ALL_CATEGORIES}
                    className="size-3.5"
                  />
                </span>
                <span>{chip.label}</span>
                {chip.count !== undefined && (
                  <span className="category-count min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-medium tabular-nums">
                    {chip.count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {/* What the chosen category is for, where a tooltip would hide it. */}
      {active !== undefined && active.why !== "" && (
        <p
          className="category-callout text-muted-foreground flex items-start gap-2.5 rounded-lg py-2 pr-3 pl-3.5 text-xs"
          data-testid="category-why"
          data-category={active.id ?? ALL_CATEGORIES}
        >
          <span className="category-chip grid size-6 shrink-0 place-items-center rounded-md">
            <CategoryIcon
              category={active.id ?? ALL_CATEGORIES}
              className="size-3.5"
            />
          </span>
          <span className="pt-1 leading-snug">
            <span className="font-semibold text-[var(--category-text)]">
              {active.label}.
            </span>{" "}
            {active.why}
          </span>
        </p>
      )}
    </nav>
  );
}
