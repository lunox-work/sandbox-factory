/**
 * The icon for each category a run picks bounties by.
 *
 * Drawn here rather than picked from Lucide: a stock icon gives "an
 * hourglass" or "a pair of scissors", where these say the category — the
 * bounty fading at one corner, the blocker in front of a card. They are
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
 * A line that is only a line (a calendar's ring) says
 * `fill="none"`, or the fill would close it into a sliver. What is
 * secondary — the pieces drifting off a card, the card a blocker stands
 * in front of — is drawn at a lower `opacity`, so each icon has one shape
 * to read first.
 */
type Drawing = { solid: ReactElement; cut?: ReactElement };

/** Keyed by category id. */
const DRAWINGS: Record<string, Drawing> = {
  // A bounty fading away from its top right corner: half of it is gone,
  // crumbled into pieces that fade the further they drift.
  "left-behind": {
    solid: (
      <>
        <path d="M5.5 2.5A2.5 2.5 0 0 0 3 5v14.5A2.5 2.5 0 0 0 5.5 22h12a2.5 2.5 0 0 0 2.5-2.5V17Z" />
        <g stroke="none">
          <rect x="11" y="0.3" width="5" height="5" rx="1.25" opacity="0.85" />
          <rect x="17" y="6.3" width="5" height="5" rx="1.25" opacity="0.85" />
          <rect
            x="19.8"
            y="0.3"
            width="3.5"
            height="3.5"
            rx="1"
            opacity="0.45"
          />
        </g>
      </>
    ),
    cut: (
      <>
        <path d="M7 13.5h4" />
        <path d="M7 17.5h8" />
      </>
    ),
  },
  // Repeat, with "+1" cut out of it: one more sprint, again. The loop is
  // one solid shape, its two corners drawn out into arrowheads that stand
  // clear of it, a notch under the one and over the other.
  "always-next-sprint": {
    solid: (
      <path d="M7 5h11V1l4.5 4L18 9v4h3v2a4 4 0 0 1-4 4H6v4l-4.5-4L6 15v-4H3V9a4 4 0 0 1 4-4Z" />
    ),
    cut: (
      <g strokeWidth="1.75">
        <path d="M8 12h3" />
        <path d="M9.5 10.5v3" />
        <path d="M13 10l2-1.5v7" />
      </g>
    ),
  },
  // An upvote inside a comment: the demand is in the thread, not in the
  // priority field.
  "quietly-wanted": {
    solid: (
      <path d="M7 4h10a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-6l-4 3.5V17a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z" />
    ),
    cut: <path d="M9 12l3-3 3 3" />,
  },
  // The blocker mark standing in front of the bounty it holds up, the
  // card faded behind it and a gap cut between the two.
  "holding-others-up": {
    solid: (
      <>
        <rect x="3" y="3" width="13" height="13" rx="2.5" opacity="0.5" />
        <circle cx="15" cy="15" r="6.5" />
      </>
    ),
    cut: (
      <>
        <circle strokeWidth="1.5" cx="15" cy="15" r="8.5" />
        <path d="M12 15h6" />
      </>
    ),
  },
  // A sheet of paper with a nick in its edge, cut rather than drawn so
  // its point stays sharp.
  "paper-cuts": {
    solid: (
      <path d="M15 2.5H6.5A2.5 2.5 0 0 0 4 5v14.5A2.5 2.5 0 0 0 6.5 22h11a2.5 2.5 0 0 0 2.5-2.5V7.5Z" />
    ),
    cut: (
      <>
        <path d="M14 2.5V6a2 2 0 0 0 2 2h4" />
        <path fill="black" strokeWidth="1" d="M22 12 12 14.75 22 17.5Z" />
      </>
    ),
  },
  // A calendar with a warning badge on its corner: the date is coming,
  // and nothing on the page is ready for it. A gap is cut around the badge
  // so the two stay apart.
  "deadline-exposed": {
    solid: (
      <>
        <path fill="none" d="M7 2v3" />
        <path fill="none" d="M14 2v3" />
        <rect x="3" y="4.5" width="15" height="15" rx="3" />
        <circle cx="17" cy="17" r="5.5" />
      </>
    ),
    cut: (
      <>
        <path d="M2 9.5h17" />
        <circle strokeWidth="1.5" cx="17" cy="17" r="7.75" />
        <path d="M17 14.5V17" />
        <path d="M17 19.75h.01" />
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
