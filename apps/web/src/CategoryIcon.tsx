/**
 * The icon for each category a run picks bounties by.
 *
 * Drawn here rather than picked from Lucide: a stock icon gives "an
 * hourglass" or "a pair of scissors", where these say the category — the
 * bounty fading at one corner, the card carrying a blocker mark. They are
 * on Lucide's grid all the same (24×24, a 2px stroke, round caps and
 * joins, `currentColor`), so they sit beside the Lucide icons the page
 * already uses and follow the text colour into dark mode.
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

import { Tag } from "lucide-react";
import type { ReactElement } from "react";

/** Keyed by category id. What is here is the inside of the `<svg>`. */
const DRAWINGS: Record<string, ReactElement> = {
  // A bounty fading away from its top right corner: the outline breaks
  // into a dash and then a dot on each side of the corner, which is gone.
  "left-behind": (
    <>
      <path d="M11 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <path d="M14.5 2h1" />
      <path d="M18.5 2.5h.01" />
      <path d="M20 9.5v-1" />
      <path d="M20 5.5h.01" />
      <path d="M8 13h5" />
      <path d="M8 17h8" />
    </>
  ),
  // Repeat, with "+1" inside it: one more sprint, again. The loop is
  // Lucide's with shorter arrowheads, to leave the middle clear, and the
  // "+1" is drawn at 1.5 so its two glyphs stay apart at a tile's 16px.
  "always-next-sprint": (
    <>
      <path d="m18 2 3 3-3 3" />
      <path d="M3 10V9a4 4 0 0 1 4-4h14" />
      <path d="m6 22-3-3 3-3" />
      <path d="M21 14v1a4 4 0 0 1-4 4H3" />
      <path strokeWidth="1.5" d="M7.5 12h4" />
      <path strokeWidth="1.5" d="M9.5 10v4" />
      <path strokeWidth="1.5" d="M14 10.25l1.75-1.25v6" />
    </>
  ),
  // An upvote inside a comment: the demand is in the thread, not in the
  // priority field.
  "quietly-wanted": (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M9 11.5l3-3 3 3" />
    </>
  ),
  // A bounty card carrying the blocker mark, a circle with a dash in it.
  "holding-others-up": (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="12" cy="12" r="5" />
      <path d="M10 12h4" />
    </>
  ),
  // A sheet of paper with a nick in its edge.
  "paper-cuts": (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2l-5-2.5 5-2.5V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  // A calendar page with nothing on it but a warning.
  "deadline-exposed": (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      <path d="M12 13v3" />
      <path d="M12 19h.01" />
    </>
  ),
};

/**
 * One category's icon. It has no size of its own: whoever places it says
 * how big, as with a Lucide icon.
 *
 * A category with no drawing gets a plain tag rather than nothing — one
 * retired from the registry but still stored on an old run, or one a
 * deploy added after this bundle was built — so a tile or a badge keeps
 * its shape whatever the API names.
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
  if (!Object.hasOwn(DRAWINGS, category)) {
    return <Tag aria-hidden="true" focusable="false" className={className} />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-category-icon={category}
      className={className}
    >
      {DRAWINGS[category]}
    </svg>
  );
}
