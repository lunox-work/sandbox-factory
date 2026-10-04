import type {
  BountyCategoryMatch,
  ProposalCategoriesDto,
} from "@sandbox-factory/shared";
import { CircleDashed, Layers } from "lucide-react";
import { type ReactElement } from "react";
import { UNCATEGORIZED } from "sandbox-factory";

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

/** `?category=` as the page will use it: a category id, or none. */
export function categoryFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("category");
  // The same shape the API accepts. Anything else is not a category, and
  // sending it on would turn a mistyped link into a failed list.
  return value !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
    ? value
    : null;
}

/**
 * A board's category summary, or null for a body that is not one: the view
 * is drawn only from a response it can read in full.
 */
function CategoryTile({
  label,
  count,
  icon,
  pressed,
  disabled = false,
  hint,
  onPress,
}: {
  label: string;
  count: number;
  /** Decoration: the label names the tile, so the icon is not read aloud. */
  icon: ReactElement;
  pressed: boolean;
  disabled?: boolean;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      // Said in reading order. The tile shows the number first because that
      // is what the eye is scanning for, which reads aloud as "7 Left behind".
      aria-label={`${label}, ${count} ${count === 1 ? "proposal" : "proposals"}`}
      disabled={disabled}
      title={hint}
      onClick={onPress}
      className={`focus-visible:ring-ring/50 flex h-full w-full flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 ${
        pressed ? "bg-muted border-foreground/30" : "hover:bg-muted/50"
      }`}
    >
      {/*
        The count where the eye lands, and the icon across from it: what
        tells one tile from the next before either label is read.
      */}
      <span className="flex w-full items-start justify-between gap-2">
        <span className="text-lg leading-none font-semibold tabular-nums">
          {count}
        </span>
        <span
          className={`shrink-0 [&>svg]:size-4 ${pressed ? "text-foreground" : "text-muted-foreground"}`}
        >
          {icon}
        </span>
      </span>
      <span
        className={`text-xs leading-tight ${pressed ? "text-foreground font-medium" : "text-muted-foreground"}`}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * The board's proposals by the reason each bounty was picked, above the
 * list they narrow.
 *
 * A run takes a bounty because it fits a category, so the categories are
 * the natural way to walk what a run produced: all the blockers, then all
 * the paper cuts. Each tile says how many the board has and, pressed, makes
 * the list below show those. The six are always the same six in the same
 * order, a category with nothing in it shown but not pressable, so a tile
 * does not move when a count reaches zero.
 *
 * After them, the bounties no run picked for a reason, which would
 * otherwise be reachable only by reading the whole list for the rows with
 * nothing under their title. It is the one tile the page names itself: it
 * is not in the registry the other six come from.
 *
 * A bounty picked for two categories is counted in both, which is why the
 * tiles can sum past "All".
 */
export function CategoryNav({
  summary,
  selected,
  onSelect,
}: {
  summary: ProposalCategoriesDto;
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const tiles = [
    ...summary.categories,
    {
      id: UNCATEGORIZED,
      label: "Uncategorized",
      why: "Picked by hand, or sized before there were categories.",
      count: summary.uncategorized,
    },
  ];
  const active = tiles.find(({ id }) => id === selected);
  return (
    <nav
      aria-label="Proposals by category"
      className="flex flex-col gap-2"
      data-testid="category-nav"
    >
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <li>
          <CategoryTile
            label="All"
            count={summary.total}
            // Not a category, so not one of their icons: the whole pile.
            icon={<Layers aria-hidden="true" focusable="false" />}
            pressed={selected === null}
            onPress={() => onSelect(null)}
          />
        </li>
        {tiles.map((category) => (
          <li key={category.id}>
            <CategoryTile
              label={category.label}
              count={category.count}
              icon={
                category.id === UNCATEGORIZED ? (
                  // No category, so no category's icon: an empty outline.
                  <CircleDashed aria-hidden="true" focusable="false" />
                ) : (
                  <CategoryIcon category={category.id} />
                )
              }
              pressed={selected === category.id}
              // An empty category is nowhere to go — unless it is the one
              // being shown, which must stay pressable to be left.
              disabled={category.count === 0 && selected !== category.id}
              hint={category.why}
              onPress={() =>
                onSelect(selected === category.id ? null : category.id)
              }
            />
          </li>
        ))}
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
