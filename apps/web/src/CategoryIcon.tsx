/**
 * The icon for each category a run picks bounties by.
 *
 * Drawn here rather than picked from Lucide: a stock icon gives "an
 * hourglass" or "a pair of scissors", where these say the category — the
 * bounty fading at one corner, the card carrying a blocker mark. They are
 * solid: each is a filled shape with its detail cut out of it, so the
 * detail shows whatever is behind the icon — a tile's wash, a pressed
 * chip — rather than a colour guessed for it. They keep Lucide's grid
 * (24×24, round caps and joins, `currentColor`), so they line up with the
 * Lucide icons beside them and follow the text colour into dark mode.
 *
 * Each is decoration. It is always beside the label that names the
 * category, so it is hidden from assistive technology rather than
 * announced a second time.
 *
 * A category is _defined_ in `packages/core`, and that registry knows
 * nothing of these. `category-icon.test.tsx` walks it and fails for a
 * category with no drawing here, which is what keeps a new one from
 * shipping with the fallback.
 */

import { CircleDashed, LayoutGrid, Tag } from "lucide-react";
import { UNCATEGORIZED } from "sandbox-factory";
import { useId, type ReactElement } from "react";

/**
 * A category's drawing: `solid` is filled and stroked at 2, so a filled
 * shape keeps the footprint its outline had; `cut` is stroked out of it.
 * A line that is only a line (a calendar's ring) says `fill="none"`, or
 * the fill would close it into a sliver.
 */
type Drawing = { solid: ReactElement; cut?: ReactElement };

/** Keyed by category id. */
const DRAWINGS: Record<string, Drawing> = {
  // A bounty fading away from its top right corner: the corner is gone,
  // and what is left of it drifts off as a dash, a dot and a dash.
  "left-behind": {
    solid: (
      <>
        <path d="M10 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8Z" />
        <path strokeWidth="2.5" d="M15 2h1.5" />
        <path strokeWidth="2.5" d="M19.5 2.5h.01" />
        <path strokeWidth="2.5" d="M20 6v1" />
      </>
    ),
    cut: (
      <>
        <path d="M8 13h5" />
        <path d="M8 17h8" />
      </>
    ),
  },
  // Repeat, with "+1" on a plate inside it: one more sprint, again. The
  // arrowheads are short, to leave the plate room, and the "+1" is cut at
  // 1.5 so its two glyphs stay apart at a tile's 16px.
  "always-next-sprint": {
    solid: (
      <>
        <path fill="none" d="M3 10V9a4 4 0 0 1 4-4h11" />
        <path d="M18.5 2.5l2.5 2.5-2.5 2.5z" />
        <path fill="none" d="M21 14v1a4 4 0 0 1-4 4H6" />
        <path d="M5.5 21.5L3 19l2.5-2.5z" />
        <rect x="7" y="8" width="10" height="8" rx="2" stroke="none" />
      </>
    ),
    cut: (
      <>
        <path strokeWidth="1.5" d="M8.75 12h3" />
        <path strokeWidth="1.5" d="M10.25 10.5v3" />
        <path strokeWidth="1.5" d="M14 10.5l1.5-1v5" />
      </>
    ),
  },
  // An upvote inside a comment: the demand is in the thread, not in the
  // priority field.
  "quietly-wanted": {
    solid: (
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    ),
    cut: <path d="M9 11.5l3-3 3 3" />,
  },
  // A bounty card carrying the blocker mark, a circle with a dash in it.
  "holding-others-up": {
    solid: <rect x="3" y="3" width="18" height="18" rx="2" />,
    cut: (
      <>
        <circle cx="12" cy="12" r="5" />
        <path d="M10 12h4" />
      </>
    ),
  },
  // A sheet of paper with a nick in its edge.
  "paper-cuts": {
    solid: (
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2l-5-2.5 5-2.5V7Z" />
    ),
    cut: <path d="M14 2v4a2 2 0 0 0 2 2h4" />,
  },
  // A calendar page with nothing on it but a warning.
  "deadline-exposed": {
    solid: (
      <>
        <path fill="none" d="M8 2v4" />
        <path fill="none" d="M16 2v4" />
        <rect x="3" y="4" width="18" height="18" rx="2" />
      </>
    ),
    cut: (
      <>
        <path d="M3 10h18" />
        <path d="M12 13v3" />
        <path d="M12 19h.01" />
      </>
    ),
  },
};

/**
 * Where categories are filtered, every one of them at once. Not a category:
 * a chip of its own beside them, styled by `data-category` as they are.
 */
export const ALL_CATEGORIES = "all";

/**
 * One category's icon. It has no size of its own: whoever places it says
 * how big, as with a Lucide icon.
 *
 * A category with no drawing gets a plain tag rather than nothing — one
 * retired from the registry but still stored on an old run, or one a
 * deploy added after this bundle was built — so a tile or a badge keeps
 * its shape whatever the API names.
 *
 * "All" and uncategorized are not in the registry but stand beside the six
 * in a filter, so they have stock icons: a grid of everything, and an empty
 * dashed outline for what is in none.
 */
export function CategoryIcon({
  category,
  className,
}: {
  category: string;
  className?: string;
}) {
  // `Object.hasOwn`, not a bare lookup: the id arrives from stored JSON,
  // and a lookup would find `constructor` on any object.
  if (category === ALL_CATEGORIES)
    return (
      <LayoutGrid aria-hidden="true" focusable="false" className={className} />
    );
  if (category === UNCATEGORIZED)
    return (
      <CircleDashed
        aria-hidden="true"
        focusable="false"
        className={className}
      />
    );
  const drawing = Object.hasOwn(DRAWINGS, category)
    ? DRAWINGS[category]
    : undefined;
  if (drawing === undefined) {
    return <Tag aria-hidden="true" focusable="false" className={className} />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-category-icon={category}
      className={className}
    >
      <Drawn category={category} drawing={drawing} />
    </svg>
  );
}

/**
 * A drawing, its cut made with a mask rather than painted over in a
 * background colour, so it is a hole whatever the icon sits on. The mask
 * is named per icon, since a page draws the same category many times.
 */
function Drawn({ category, drawing }: { category: string; drawing: Drawing }) {
  // `useId` is wrapped in colons, which `url(#…)` does not take bare. The
  // category is in the name too: two React roots each count from zero.
  const mask = `category-cut-${category}-${useId().replace(/[^\w-]/g, "")}`;
  if (drawing.cut === undefined) return drawing.solid;
  return (
    <>
      <mask
        id={mask}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="white" stroke="none" />
        <g fill="none" stroke="black">
          {drawing.cut}
        </g>
      </mask>
      <g mask={`url(#${mask})`}>{drawing.solid}</g>
    </>
  );
}
