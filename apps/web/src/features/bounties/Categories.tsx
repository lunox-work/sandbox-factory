import type {
  BountyCategoryCountsDto,
  BountyCategoryMatch,
} from "@sandbox-factory/shared";
import { CATEGORIES, UNCATEGORIZED } from "sandbox-factory";

import { cn } from "@/lib/utils";

import { CategoryIcon } from "../../CategoryIcon";

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
      <span className="text-foreground/80 font-medium">
        {/* At the text's own size, and dropped a hair to sit on its line. */}
        <CategoryIcon
          category={first.id}
          className="mr-1 inline-block size-3 align-[-0.125em]"
        />
        {first.label}
      </span>
      {" · "}
      {first.reason}
      {rest.length > 0 && ` · +${rest.length} more`}
    </span>
  );
}

/**
 * The bounties by the category their board's scan found them in, as one
 * row of plain chips above the list: All, the six in registry order, and
 * the bounties in none, called "Unassigned". No icons: each card's category
 * line carries its category's, and without them the row fits on one line. Each says how many it holds, and
 * pressed narrows the list to them. A chip with none is still there, dimmed,
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
            <li key={chip.id ?? "all"} className="shrink-0">
              <button
                type="button"
                aria-pressed={pressed}
                disabled={empty && !pressed}
                title={chip.why === "" ? undefined : chip.why}
                onClick={() => onSelect(pressed ? null : chip.id)}
                className={cn(
                  "focus-visible:ring-ring/50 inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
                  pressed
                    ? "bg-foreground text-background border-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span className={pressed ? "font-medium" : undefined}>
                  {chip.label}
                </span>
                {chip.count !== undefined && (
                  <span
                    className={cn(
                      "tabular-nums",
                      pressed
                        ? "text-background/70"
                        : "text-muted-foreground/70",
                    )}
                  >
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
        <p className="text-muted-foreground text-xs" data-testid="category-why">
          <span className="text-foreground font-medium">{active.label}.</span>{" "}
          {active.why}
        </p>
      )}
    </nav>
  );
}
