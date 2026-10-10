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
 * Each moves, quietly and forever, acting out its category: the bounty
 * streams away as dust, the next sprint pulls at the loop, the upvote
 * rises. The motion is in `index.css` (`ci-*`), keyed on class names
 * given to the parts here or on the icon's `data-category-icon`, and stops
 * for anyone who asks for reduced motion.
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
import { useId, type CSSProperties, type ReactElement } from "react";

/**
 * A category's drawing: `solid` is filled and stroked at 2, so a filled
 * shape keeps the footprint its outline had; `cut` is stroked out of it.
 * A line that is only a line (a calendar's ring) says
 * `fill="none"`, or the fill would close it into a sliver. What is
 * secondary — the pieces drifting off a card, the card a blocker stands
 * in front of — is drawn at a lower `opacity`, so each icon has one shape
 * to read first.
 */
type Drawing = { solid: Part; cut?: Part };

/**
 * A part of a drawing, or one that needs ids of its own (a clip path) and
 * makes them from the name it is given, which is the icon's own.
 */
type Part = ReactElement | ((name: string) => ReactElement);

/**
 * "Left behind" is a page on a grid of 3.2-unit cells, dissolving from its
 * top right corner. What is still whole is one shape, stepped along the
 * grid; the cells along its steps hold loose tiles, the page coming
 * apart; past them it is dust.
 */
const PAGE_LEFT =
  "M5.5 2.9H8.6V6.4H11.8V9.6H15V12.8H18.5V19.1A2 2 0 0 1 16.5 21.1H5.5A2 2 0 0 1 3.5 19.1V4.9A2 2 0 0 1 5.5 2.9Z";

/** The loose tiles, each in its cell along the page's steps. */
const TILES = [
  [9.7, 2.7],
  [12.9, 5.9],
  [16.1, 9.1],
];

/**
 * The dust, from the cells past the tiles. Each starts in its own lane,
 * square to the page's steps, and no two lanes overlap, so dust streaming
 * the same way never crosses. In motion each lane carries a second piece
 * too, half a stream behind the first and hidden when nothing moves.
 * `opacity` is how each rests, fainter the further it is gone.
 */
const DUST = [
  { x: 13.3, y: 3.1, opacity: 0.55 },
  { x: 16.5, y: 3.1, opacity: 0.3 },
  { x: 16.5, y: 6.3, opacity: 0.55 },
];

/** The sheet "Paper cuts" is drawn on. */
const SHEET =
  "M15 2.5H6.5A2.5 2.5 0 0 0 4 5v14.5A2.5 2.5 0 0 0 6.5 22h11a2.5 2.5 0 0 0 2.5-2.5V7.5Z";

/** Keyed by category id. */
const DRAWINGS: Record<string, Drawing> = {
  // A bounty fading away from its top right corner: the page breaks into
  // tiles there, and the tiles into dust. In motion the tiles crumble off
  // and re-form, and the dust streams away.
  "left-behind": {
    solid: (
      <g stroke="none">
        <path strokeWidth="1" stroke="currentColor" d={PAGE_LEFT} />
        {TILES.map(([x, y], i) => (
          <rect
            key={i}
            className="ci-crumble"
            style={{ "--i": i } as CSSProperties}
            x={x}
            y={y}
            width="2.6"
            height="2.6"
            rx="0.6"
            opacity="0.8"
          />
        ))}
        {DUST.flatMap(({ x, y, opacity }, lane) =>
          [0, 1].map((twin) => (
            <rect
              key={`${lane}-${twin}`}
              className="ci-flow"
              style={
                {
                  "--i": lane + twin * (DUST.length / 2),
                  "--o": opacity + 0.2,
                } as CSSProperties
              }
              x={x}
              y={y}
              width="1.8"
              height="1.8"
              rx="0.5"
              opacity={twin === 0 ? opacity : 0}
            />
          )),
        )}
      </g>
    ),
    cut: (
      <>
        <path d="M6.5 11.5H11" />
        <path d="M6.5 15h9" />
        <path d="M6.5 18.5h6" />
      </>
    ),
  },
  // Repeat, with "+1" cut out of it: one more sprint, again. The loop is
  // one solid shape, its two corners drawn out into arrowheads that stand
  // clear of it, a notch under the one and over the other. The arrowhead
  // pointing on to the next sprint is its own shape, so it can be pulled
  // that way and snap back.
  "always-next-sprint": {
    solid: (
      <>
        <path d="M7 5h11v8h3v2a4 4 0 0 1-4 4H6v4l-4.5-4L6 15v-4H3V9a4 4 0 0 1 4-4Z" />
        <g className="ci-pull">
          <path d="M18 1l4.5 4L18 9Z" />
          {/* Its shaft, hidden in the loop until the arrowhead is pulled
              out of it. */}
          <rect x="13" y="5" width="5.5" height="1" />
        </g>
      </>
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
    cut: <path className="ci-rise" d="M9 12l3-3 3 3" />,
  },
  // The blocker mark standing in front of the bounty it holds up, the
  // card faded behind it and a gap cut between the two.
  "holding-others-up": {
    solid: (
      <>
        <rect x="3" y="3" width="13" height="13" rx="2.5" opacity="0.5" />
        <circle className="ci-hold" cx="15" cy="15" r="6.5" />
      </>
    ),
    cut: (
      <>
        <circle className="ci-hold" strokeWidth="1.5" cx="15" cy="15" r="8.5" />
        <path className="ci-hold" d="M12 15h6" />
      </>
    ),
  },
  // A sheet of paper with a nick in its edge, cut rather than drawn so
  // its point stays sharp. The sheet is two pieces, the base and the flap
  // above the nick, so the flap alone can lift at the cut; the base runs
  // up under the flap a little, so no seam shows between them.
  "paper-cuts": {
    solid: (name) => (
      <>
        <defs>
          <clipPath id={`${name}-flap`}>
            <path d="M-2-2h28v12.9L12 14.75H-2Z" />
          </clipPath>
          <clipPath id={`${name}-base`}>
            <path d="M-2 13.75h13l1 1 14 3.85V26H-2Z" />
          </clipPath>
        </defs>
        <path clipPath={`url(#${name}-base)`} d={SHEET} />
        <g className="ci-flap">
          <path clipPath={`url(#${name}-flap)`} d={SHEET} />
        </g>
      </>
    ),
    cut: (
      <>
        <path className="ci-flap" d="M14 2.5V6a2 2 0 0 0 2 2h4" />
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
        <circle className="ci-ring" cx="17" cy="17" r="5.5" />
      </>
    ),
    cut: (
      <>
        <path d="M2 9.5h17" />
        <circle
          className="ci-ring"
          strokeWidth="1.5"
          cx="17"
          cy="17"
          r="7.75"
        />
        <path className="ci-ring" d="M17 14.5V17" />
        <path className="ci-ring" d="M17 19.75h.01" />
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
  // The mask reaches past the 24-unit box on every side, so a part that
  // moves past the box's edge is not cut off there.
  // `useId` is wrapped in colons, which `url(#…)` does not take bare. The
  // category is in the name too: two React roots each count from zero.
  const mask = `category-cut-${category}-${useId().replace(/[^\w-]/g, "")}`;
  const draw = (part: Part) => (typeof part === "function" ? part(mask) : part);
  if (drawing.cut === undefined) return draw(drawing.solid);
  return (
    <>
      <mask
        id={mask}
        maskUnits="userSpaceOnUse"
        x="-4"
        y="-4"
        width="32"
        height="32"
      >
        <rect x="-4" y="-4" width="32" height="32" fill="white" stroke="none" />
        <g fill="none" stroke="black">
          {draw(drawing.cut)}
        </g>
      </mask>
      <g mask={`url(#${mask})`}>{draw(drawing.solid)}</g>
    </>
  );
}
