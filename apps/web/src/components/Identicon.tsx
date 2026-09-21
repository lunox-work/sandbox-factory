/**
 * The generated avatar: a 5x5 mirrored grid of blocks in a colour, both
 * derived from an account id.
 *
 * Inline SVG rather than a request, following `ProviderIcon`: there is nothing
 * to fetch, because the mark is a pure function of an id the app already holds
 * (`packages/shared/src/identicon.ts`). Decorative, so it is hidden from
 * assistive technology — the name beside or behind the avatar is what carries
 * the meaning.
 */

import { identicon } from "@sandbox-factory/shared";

/**
 * One cell of padding on every side.
 *
 * User avatars are clipped to a circle, and the corners of a square go with
 * it: unpadded, only 14% of each corner cell survives the crop, so a grid with
 * a corner filled would render slivers. A full cell of padding leaves all of
 * it. Organizations, in a rounded square, do not need this, but one viewBox
 * keeps one code path and means a person and an organization that happen to
 * share a grid are recognisably the same mark.
 */
const VIEW_BOX = "-1 -1 7 7";

export function Identicon({
  seed,
  className,
}: {
  /** An account id. Never a name: a face must not change on a rename. */
  seed: string;
  className?: string;
}) {
  const { cells, hue } = identicon(seed);

  return (
    <svg
      viewBox={VIEW_BOX}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/*
        One path for the whole grid rather than a rect per cell. At 24px a cell
        is 3.43 device pixels, and abutting rects at fractional sizes
        anti-alias independently, leaving hairline seams through what should
        read as one block. A single path is rasterised in one pass and has
        none. It is also one node instead of up to twenty-five, which is worth
        having in a member list.
      */}
      <path
        d={cells
          .map((filled, index) =>
            filled ? `M${index % 5} ${Math.floor(index / 5)}h1v1h-1z` : "",
          )
          .join("")}
        // The tokens are per theme and live in `index.css`; the hue is the
        // only part of the colour this component knows.
        fill={`oklch(var(--identicon-l) var(--identicon-c) ${hue})`}
      />
    </svg>
  );
}
