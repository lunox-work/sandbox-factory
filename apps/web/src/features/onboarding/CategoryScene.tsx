/**
 * A small looping scene at the head of each card in "What task do teams outsource?",
 * acting out what the category means rather than restating its label.
 *
 * - Left behind: the team's work streams past on a lane while one ticket
 *   sits below it, fading, idle for months.
 * - Always next sprint: sprints slide by underneath a ticket that hops into
 *   the next one each time, picking up another "+1".
 * - Quietly wanted: comments arrive and each sends an upvote to a counter,
 *   while the priority field beside it still says Low.
 * - Holding others up: one blocked ticket keeps three waiting; it resolves,
 *   and the work flows through to all of them.
 * - Paper cuts: a scan passes down a small window and each bug it reaches
 *   turns into a check.
 * - Deadline exposed: today slides along a timeline toward a flag, the days
 *   left counting down as the bar warms from blue to red.
 *
 * Drawn in markup and animated in CSS (`index.css`, "category scenes"),
 * each on its own loop length so the six never pulse in step. Every part
 * moves by transform and opacity. Under reduced motion each one stands
 * still on a frame that tells the same story.
 *
 * Decoration only: the card's text says all of it, so the scene is hidden
 * from assistive technology. It holds no list items, and no text that
 * repeats the card's, so queries over the dialog find only the cards.
 */

import type { CSSProperties, ReactElement } from "react";

import { CategoryIcon } from "../../CategoryIcon";

/** An index for a staggered part, read by the CSS as `--i`. */
const nth = (i: number) => ({ "--i": i }) as CSSProperties;

function Ticket({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={`scene-ticket ${className}`} style={style} />;
}

/** Lucide's repeat, inline so it can turn on its own. */
const REPEAT = (
  <svg viewBox="0 0 24 24" className="ns-repeat">
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);

const CHEVRON_UP = (
  <svg viewBox="0 0 12 12">
    <path d="M2.5 7.5 6 4l3.5 3.5" />
  </svg>
);

const CHECK = (
  <svg viewBox="0 0 12 12">
    <path d="m3 6.2 2 2L9 4" />
  </svg>
);

/** A beetle seen from above, at 12px. */
const BUG = (
  <svg viewBox="0 0 12 12">
    <path d="M3.2 4.6 1.6 3.6M3 6.5H1.3M3.2 8.4l-1.6 1M8.8 4.6l1.6-1M9 6.5h1.7M8.8 8.4l1.6 1" />
    <ellipse cx="6" cy="7" rx="2.7" ry="3.2" />
    <circle cx="6" cy="3" r="1.4" />
  </svg>
);

const SCENES: Record<string, ReactElement> = {
  "left-behind": (
    <>
      <span className="lb-lane">
        <span className="lb-track">
          {Array.from({ length: 10 }, (_, i) => (
            <Ticket key={i} className={i % 5 === 1 ? "lb-done" : ""} />
          ))}
        </span>
      </span>
      <Ticket className="scene-hero lb-stuck" />
      {[0, 1, 2].map((i) => (
        <span key={i} className="lb-dust" style={nth(i)} />
      ))}
      <span className="lb-age">
        <svg viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.5" />
          <path className="lb-hand" d="M6 6V3.4" />
          <path d="M6 6h1.8" />
        </svg>
        idle 214d
      </span>
    </>
  ),

  "always-next-sprint": (
    <>
      <span className="ns-label" style={nth(0)}>
        now
      </span>
      <span className="ns-label ns-label-next" style={nth(1)}>
        next
      </span>
      <span className="ns-label" style={nth(2)}>
        later
      </span>
      <span className="ns-strip">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="ns-sprint">
            <span className="ns-done" />
            <span className="ns-done" />
          </span>
        ))}
      </span>
      <span className="ns-hero">
        <Ticket className="scene-hero" />
        {REPEAT}
      </span>
      <span className="ns-plus">+1</span>
    </>
  ),

  "quietly-wanted": (
    <>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`qw-comment qw-${i}`} style={nth(i)}>
          <span className="qw-avatar" />
          <span className="qw-line" />
        </span>
      ))}
      {[0, 1, 2].map((i) => (
        <span key={i} className="qw-fly" style={nth(i)}>
          {CHEVRON_UP}
        </span>
      ))}
      <span className="qw-votes">
        <span className="qw-arrow">{CHEVRON_UP}</span>
        <span className="qw-count">
          <span className="qw-digits">
            <span>12</span>
            <span>13</span>
            <span>14</span>
            <span>15</span>
          </span>
        </span>
      </span>
      <span className="qw-priority">
        <span className="qw-priority-dot" />
        Priority: Low
      </span>
    </>
  ),

  "holding-others-up": (
    <svg viewBox="0 0 200 88" className="ho-graph">
      {[14, 44, 74].map((y, i) => (
        <g key={y} style={nth(i)}>
          <path className="ho-edge" d={`M74 44C104 44 106 ${y} 134 ${y}`} />
          <path
            className="ho-flow"
            pathLength={1}
            d={`M74 44C104 44 106 ${y} 134 ${y}`}
          />
        </g>
      ))}
      {[4, 34, 64].map((y, i) => (
        <g key={y} className="ho-waiting" style={nth(i)}>
          <rect
            className="ho-card"
            x="136"
            y={y}
            width="58"
            height="20"
            rx="4"
          />
          <rect
            className="ho-card-lit"
            x="136"
            y={y}
            width="58"
            height="20"
            rx="4"
          />
          <path className="ho-text" d={`M143 ${y + 10}h24`} />
          <circle className="ho-wait" cx="183" cy={y + 10} r="3.5" />
          <g className="ho-tick">
            <circle cx="183" cy={y + 10} r="4.5" />
            <path d={`m181 ${y + 10.2} 1.4 1.4 2.6-2.8`} />
          </g>
        </g>
      ))}
      <rect
        className="ho-card ho-blocker"
        x="6"
        y="29"
        width="58"
        height="30"
        rx="4"
      />
      <rect
        className="ho-blocker-lit"
        x="6"
        y="29"
        width="58"
        height="30"
        rx="4"
      />
      <path className="ho-text" d="M13 39h28M13 47h18" />
      <circle className="ho-ripple" cx="64" cy="44" r="9" />
      <circle className="ho-ripple" cx="64" cy="44" r="9" style={nth(1)} />
      <g className="ho-block">
        <circle cx="64" cy="44" r="9" />
        <path d="M60.5 44h7" />
      </g>
      <g className="ho-free">
        <circle cx="64" cy="44" r="9" />
        <path d="m60.2 44.2 2.6 2.6 5-5.2" />
      </g>
    </svg>
  ),

  "paper-cuts": (
    <span className="pc-window">
      <span className="pc-bar">
        <span />
        <span />
        <span />
      </span>
      {[0, 1, 2].map((i) => (
        <span key={i} className="pc-row" style={nth(i)}>
          <span className="pc-text" />
          <span className="pc-bug">{BUG}</span>
          <span className="pc-check">{CHECK}</span>
        </span>
      ))}
      <span className="pc-scan" />
    </span>
  ),

  "deadline-exposed": (
    <>
      <span className="de-flag">
        <span className="de-pole" />
        <span className="de-cloth">due</span>
        <span className="de-pulse" />
      </span>
      <span className="de-track">
        <span className="de-fill" />
      </span>
      <span className="de-ticks" />
      <span className="de-today">
        <span className="de-left">
          <span className="de-days">
            <span>14d</span>
            <span>7d</span>
            <span>3d</span>
            <span>1d</span>
          </span>
        </span>
        <span className="de-dot" />
      </span>
    </>
  ),
};

/**
 * The scene for one category. One the registry gained after this was
 * drawn gets its icon, large and drifting, so its card keeps the shape of
 * the others rather than a gap at its head.
 */
export function CategoryScene({ category }: { category: string }) {
  // `Object.hasOwn`, as in `CategoryIcon`: a bare lookup would find
  // `constructor` on any object.
  const drawn = Object.hasOwn(SCENES, category);
  return (
    <span
      className="scene"
      data-scene-drawing={drawn ? category : undefined}
      aria-hidden="true"
    >
      <span className="scene-canvas">
        {drawn ? (
          SCENES[category]
        ) : (
          <CategoryIcon category={category} className="scene-fallback" />
        )}
      </span>
    </span>
  );
}
