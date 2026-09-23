import { maximumRateCardMinor } from "sandbox-factory";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import {
  formatRateAmount,
  parseRateAmount,
  ungroupAmount,
} from "@/lib/rate-amount";

type Endpoint = "XS" | "XL";
const middleSizes = ["S", "M", "L"] as const;
type Middle = (typeof middleSizes)[number];
type Size = Endpoint | Middle;
const HANDLE_SPACING = 40;
const MIN_TRACK_WIDTH = 300;
const EDGE_SPACE = 0.1;
const SLIDER_STEP = 5;

/**
 * Snap to the absolute step grid rather than stepping relative to the current
 * value: an off-grid 21 moves to 20 or 25, never to 16 or 26. `direction`
 * rounds down (-1), up (1) or to the nearest (0).
 */
function snapToStep(value: number, direction: -1 | 0 | 1 = 0): number {
  const round =
    direction === -1 ? Math.floor : direction === 1 ? Math.ceil : Math.round;
  return round(value / SLIDER_STEP) * SLIDER_STEP;
}

function RateHandle({
  size,
  value,
  currency,
  disabled,
  onApply,
  sliderProps,
  position,
  editorOffset = 0,
  trackRef,
}: {
  size: Size;
  value: string;
  currency: string;
  disabled: boolean;
  onApply: (draft: string) => string | null;
  sliderProps: {
    min: number;
    max: number;
    now: number;
    scaleMin: number;
    scaleMax: number;
    positionScale: number;
    dragMin: number;
    dragMax: number;
    description: string;
    onMove: (value: number, commit: boolean) => void;
    onDragging: (dragging: boolean) => void;
  };
  position: number;
  editorOffset?: number;
  trackRef: RefObject<HTMLDivElement | null>;
}) {
  const below = size === "S" || size === "L";
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressClick = useRef(false);
  const latestSliderProps = useRef(sliderProps);
  latestSliderProps.current = sliderProps;
  const removeDragListeners = useRef(() => {});
  useEffect(() => () => removeDragListeners.current(), []);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    moved: boolean;
    value: number;
    initialValue: number;
    unitsPerPixel: number;
    min: number;
    max: number;
  } | null>(null);
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function commit() {
    if (!editing || disabled) return;
    const message = onApply(draft);
    setError(message);
    if (message === null) setEditing(false);
  }

  function dragValue(clientX: number): number | null {
    const start = gesture.current;
    if (!start || (Math.abs(clientX - start.x) < 3 && !start.moved))
      return null;
    start.moved = true;
    // Use the grab point and scale captured at pointerdown, so taking hold of
    // a thumb off-center or a layout change cannot make its value jump.
    start.value = Math.max(
      start.min,
      Math.min(
        start.max,
        snapToStep(
          start.initialValue + (clientX - start.x) * start.unitsPerPixel,
        ),
      ),
    );
    return start.value;
  }

  function cancelDrag(pointerId: number) {
    const start = gesture.current;
    if (!start || start.pointerId !== pointerId) return;
    gesture.current = null;
    removeDragListeners.current();
    suppressClick.current = true;
    if (start.moved)
      latestSliderProps.current.onMove(start.initialValue, false);
    latestSliderProps.current.onDragging(false);
  }

  return (
    <div
      className="rate-position group absolute top-1/2 left-0 z-10 focus-within:z-30"
      style={{
        transform: `translateX(${position - 16}px) translateY(-16px)`,
      }}
    >
      <span
        aria-hidden="true"
        className={`bg-border pointer-events-none absolute left-1/2 w-px -translate-x-1/2 ${below ? "top-8" : "bottom-8"}`}
        style={{ height: 24 + editorOffset }}
      />
      <div
        style={
          below ? { top: 56 + editorOffset } : { bottom: 56 + editorOffset }
        }
        className={`bg-background absolute left-1/2 flex h-9 w-28 -translate-x-1/2 items-center gap-1.5 rounded-md border px-2.5 shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15 ${error ? "border-destructive" : "border-border"}`}
      >
        <span
          aria-hidden="true"
          className="text-muted-foreground shrink-0 text-[10px] font-medium"
        >
          {currency}
        </span>
        <input
          ref={inputRef}
          aria-label={`${size} rate`}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${id}-error` : undefined}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          className="text-foreground h-full min-w-0 flex-1 bg-transparent text-right text-xs font-medium tabular-nums outline-none disabled:cursor-default"
          value={editing ? draft : formatRateAmount(value)}
          onFocus={(event) => {
            setDraft(value);
            setEditing(true);
            setError(null);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setDraft(ungroupAmount(event.target.value));
            setEditing(true);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(value);
              setEditing(false);
              setError(null);
            }
          }}
        />
      </div>
      <button
        type="button"
        role="slider"
        aria-label={`${size} rate`}
        aria-disabled={disabled}
        aria-describedby={sliderProps.description}
        aria-valuemin={sliderProps.min}
        aria-valuemax={sliderProps.max}
        aria-valuenow={sliderProps.now}
        aria-valuetext={`${currency} ${formatRateAmount(value)}`}
        disabled={disabled}
        className="text-foreground relative flex size-8 touch-none cursor-grab items-center justify-center rounded-full border-[3px] border-transparent text-[10px] font-semibold shadow-sm outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default"
        style={{
          background:
            "linear-gradient(var(--background), var(--background)) padding-box, var(--brand-gradient) border-box",
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          inputRef.current?.focus();
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || gesture.current) return;
          const width = trackRef.current?.getBoundingClientRect().width ?? 0;
          if (width <= 0) return;
          suppressClick.current = false;
          setEditing(false);
          setError(null);
          const dragMin =
            size === "XS"
              ? Math.min(sliderProps.dragMin, sliderProps.now - SLIDER_STEP)
              : sliderProps.dragMin;
          const dragMax =
            size === "XL"
              ? Math.max(sliderProps.dragMax, sliderProps.now + SLIDER_STEP)
              : sliderProps.dragMax;
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            moved: false,
            value: sliderProps.now,
            initialValue: sliderProps.now,
            // Clamp to the grid itself, so a snapped value is never pulled
            // back off-grid by its own bounds.
            min: Math.max(sliderProps.min, snapToStep(dragMin, 1)),
            max: Math.min(sliderProps.max, snapToStep(dragMax, -1)),
            unitsPerPixel: Math.max(
              (sliderProps.scaleMax - sliderProps.scaleMin) /
                (width * sliderProps.positionScale),
              // Even a narrow range needs one full step in the runway.
              size === "XS" || size === "XL"
                ? SLIDER_STEP / (width * EDGE_SPACE)
                : 0,
            ),
          };
          const handle = event.currentTarget;
          const pointerId = event.pointerId;
          // Capture can be lost before pointerup. Track the active pointer at
          // window level so leaving/releasing outside the thumb still commits.
          const move = (nextEvent: PointerEvent) => {
            if (gesture.current?.pointerId !== nextEvent.pointerId) return;
            const next = dragValue(nextEvent.clientX);
            if (next !== null) latestSliderProps.current.onMove(next, false);
          };
          const release = (nextEvent: PointerEvent) => {
            const start = gesture.current;
            if (!start || start.pointerId !== nextEvent.pointerId) return;
            const next = dragValue(nextEvent.clientX);
            suppressClick.current = start.moved;
            gesture.current = null;
            removeDragListeners.current();
            if (next !== null) latestSliderProps.current.onMove(next, true);
            latestSliderProps.current.onDragging(false);
            if (handle.hasPointerCapture(pointerId))
              handle.releasePointerCapture(pointerId);
          };
          const cancel = (nextEvent: PointerEvent) =>
            cancelDrag(nextEvent.pointerId);
          const blur = () => cancelDrag(pointerId);
          window.addEventListener("pointermove", move, true);
          window.addEventListener("pointerup", release, true);
          window.addEventListener("pointercancel", cancel, true);
          window.addEventListener("blur", blur);
          removeDragListeners.current = () => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", release, true);
            window.removeEventListener("pointercancel", cancel, true);
            window.removeEventListener("blur", blur);
          };
          handle.setPointerCapture(pointerId);
          sliderProps.onDragging(true);
        }}
        onKeyDown={(event) => {
          const pages =
            event.key === "PageUp" || event.key === "PageDown" ? 10 : 1;
          // An off-grid value snaps onto the grid on the first press, then
          // moves a whole step at a time: 21 → 20 → 15, never 21 → 16.
          const up = (): number =>
            snapToStep(sliderProps.now, 1) === sliderProps.now
              ? sliderProps.now + pages * SLIDER_STEP
              : snapToStep(sliderProps.now, 1) + (pages - 1) * SLIDER_STEP;
          const down = (): number =>
            snapToStep(sliderProps.now, -1) === sliderProps.now
              ? sliderProps.now - pages * SLIDER_STEP
              : snapToStep(sliderProps.now, -1) - (pages - 1) * SLIDER_STEP;
          const next =
            event.key === "Home"
              ? sliderProps.min
              : event.key === "End"
                ? sliderProps.max
                : ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key)
                  ? up()
                  : ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
                    ? down()
                    : null;
          if (next !== null) {
            event.preventDefault();
            sliderProps.onMove(next, true);
          }
        }}
      >
        {size}
      </button>
      {error && (
        <span
          id={`${id}-error`}
          role="alert"
          className={`bg-background text-destructive absolute left-1/2 w-48 -translate-x-1/2 rounded-md border p-2 text-xs shadow-sm ${below ? "top-24" : "top-10"}`}
        >
          {error}
        </span>
      )}
    </div>
  );
}

export function RateSlider({
  currency,
  digits,
  values,
  onValueChange,
  onValueCommit,
  disabled,
}: {
  currency: string;
  digits: number;
  values: Record<string, string>;
  onValueChange: (values: Record<string, string>) => void;
  onValueCommit: (values: Record<string, string>) => void;
  disabled: boolean;
}) {
  const hintId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(480);
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      if (width > 0) setTrackWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);
  const small = parseRateAmount(values.XS ?? "", 0);
  const large = parseRateAmount(values.XL ?? "", 0);
  const middleAmounts = middleSizes.map((size) =>
    parseRateAmount(values[size] ?? "", 0),
  );
  const ready = small !== null && large !== null && small > 0 && large >= small;
  const movable = ready && large > small;
  const safeMaximum = Math.floor(maximumRateCardMinor(currency) / 10 ** digits);
  // Capture the viewport for the whole gesture; at rest it follows both endpoints.
  const [dragRange, setDragRange] = useState<{
    small: number;
    large: number;
  } | null>(null);
  const rangeSmall = dragRange?.small ?? small ?? 10;
  const rangeLarge = dragRange?.large ?? large ?? 200;
  const range = Math.max(1, rangeLarge - rangeSmall);
  const minimum = 1;
  const maximum = safeMaximum;
  const setDragging = (active: boolean) =>
    setDragRange(active ? { small: rangeSmall, large: rangeLarge } : null);
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  function applyEndpoint(size: Endpoint, draft: string): string | null {
    const minor = parseRateAmount(draft, digits);
    const next = parseRateAmount(draft, 0);
    if (minor === null || next === null || next <= 0)
      return `Enter a positive whole-number ${currency} amount. Decimals are not supported.`;
    if (size === "XL" && minor > maximumRateCardMinor(currency))
      return "XL cannot exceed USD 1,000.";
    const nextSmall = size === "XS" ? next : small;
    const nextLarge = size === "XL" ? next : large;
    if (nextSmall !== null && nextLarge !== null && nextSmall > nextLarge)
      return "XS must be less than or equal to XL.";
    const updated = { ...values, [size]: String(next) };
    if (nextSmall !== null && nextLarge !== null && nextSmall > 0) {
      const position = (amount: number | null, fallback: number) =>
        movable && amount !== null
          ? clamp((amount - small) / (large - small), 0, 1)
          : fallback;
      let previous = 0;
      middleSizes.forEach((middle, index) => {
        const ratio = Math.max(
          previous,
          position(middleAmounts[index] ?? null, (index + 1) / 4),
        );
        updated[middle] = String(
          nextSmall + Math.round((nextLarge - nextSmall) * ratio),
        );
        previous = ratio;
      });
    }
    onValueChange(updated);
    onValueCommit(updated);
    return null;
  }

  function bounds(size: Middle) {
    const index = middleSizes.indexOf(size);
    return {
      min: middleAmounts[index - 1] ?? small ?? 0,
      max: middleAmounts[index + 1] ?? large ?? 0,
    };
  }

  function setMiddle(size: Middle, next: number, commit = false) {
    if (!movable || disabled) return;
    const { min, max } = bounds(size);
    const updated = { ...values, [size]: String(clamp(next, min, max)) };
    onValueChange(updated);
    if (commit) onValueCommit(updated);
  }

  function endpointBounds(size: Endpoint) {
    return size === "XS"
      ? { min: minimum, max: middleAmounts[0] ?? large ?? minimum }
      : { min: middleAmounts[2] ?? small ?? minimum, max: maximum };
  }

  function setEndpoint(size: Endpoint, next: number, commit = false) {
    if (!ready || disabled) return;
    const { min, max } = endpointBounds(size);
    const updated = { ...values, [size]: String(clamp(next, min, max)) };
    onValueChange(updated);
    if (commit) onValueCommit(updated);
  }

  function applyMiddle(size: Middle, draft: string): string | null {
    const next = parseRateAmount(draft, 0);
    if (next === null || next <= 0 || parseRateAmount(draft, digits) === null)
      return `Enter a positive whole-number ${currency} amount. Decimals are not supported.`;
    const { min, max } = bounds(size);
    if (min === null || max === null || next < min || next > max)
      return `${size} must be between ${currency} ${formatRateAmount(String(min ?? 0))} and ${formatRateAmount(String(max ?? 0))}.`;
    setMiddle(size, next, true);
    return null;
  }

  const sizes = ["XS", ...middleSizes, "XL"] as const;
  // Reserve physical space for the handles independently of price differences.
  // Equal prices remain valid; their circles still have an 8px clear gap.
  const layoutWidth = Math.max(MIN_TRACK_WIDTH, trackWidth);
  const minimumGap = HANDLE_SPACING / layoutWidth;
  const priceSpace = 1 - 2 * EDGE_SPACE - minimumGap * (sizes.length - 1);
  const positions = sizes.map((size, index) => {
    const amount = parseRateAmount(values[size] ?? "", 0);
    const pricePosition =
      ready && amount !== null
        ? (amount - rangeSmall) / range +
          (rangeLarge === rangeSmall ? index / 4 : 0)
        : index / 4;
    return clamp(
      EDGE_SPACE + index * minimumGap + pricePosition * priceSpace,
      index * minimumGap,
      1 - (sizes.length - 1 - index) * minimumGap,
    );
  });
  const railStart = positions[0] ?? 0;
  const railEnd = positions[4] ?? 1;
  // Only the price editors stagger. Every circular handle stays on the rail.
  const occupied: { position: number; offset: number; below: boolean }[] = [];
  const editorOffsets = positions.map((point, index) => {
    const below = index % 2 === 1;
    let offset = 0;
    while (
      occupied.some(
        (other) =>
          other.below === below &&
          other.offset === offset &&
          Math.abs(other.position - point) * layoutWidth < 124,
      )
    )
      offset += 48;
    occupied.push({ position: point, offset, below });
    return offset;
  });

  return (
    <div className="pt-3" role="group" aria-label="Bounty rate scale">
      <p id={hintId} className="text-muted-foreground text-xs">
        {disabled
          ? "Rates by complexity."
          : "Edit a price or drag any handle. Changes save automatically."}
      </p>
      <div className="overflow-x-auto">
        <div
          className={`mx-14 ${disabled ? "opacity-60" : ""}`}
          style={{
            minWidth: MIN_TRACK_WIDTH,
            paddingTop:
              104 +
              Math.max(
                0,
                ...editorOffsets.filter((_, index) => index % 2 === 0),
              ),
            paddingBottom:
              64 +
              Math.max(
                0,
                ...editorOffsets.filter((_, index) => index % 2 === 1),
              ),
          }}
        >
          <div
            ref={trackRef}
            className="relative h-8"
            data-rate-dragging={dragRange !== null}
          >
            <div
              aria-hidden="true"
              data-rate-rail=""
              className="rate-position absolute top-1/2 left-0 h-1 w-full origin-left -translate-y-1/2 rounded-full"
              style={{
                transform: `translateX(${railStart * layoutWidth}px) scaleX(${Math.max(0, railEnd - railStart)})`,
                backgroundImage: "var(--brand-gradient)",
              }}
            />
            {sizes.map((size, index) => {
              const isMiddle = size !== "XS" && size !== "XL";
              return (
                <RateHandle
                  key={size}
                  size={size}
                  value={values[size] ?? ""}
                  currency={currency}
                  disabled={disabled || (isMiddle && !movable)}
                  position={(positions[index] ?? index / 4) * layoutWidth}
                  editorOffset={editorOffsets[index] ?? 0}
                  trackRef={trackRef}
                  sliderProps={{
                    ...(isMiddle ? bounds(size) : endpointBounds(size)),
                    now: parseRateAmount(values[size] ?? "", 0) ?? 0,
                    scaleMin: rangeSmall,
                    scaleMax: rangeSmall + range,
                    dragMin: Math.floor(
                      rangeSmall +
                        ((-EDGE_SPACE - index * minimumGap) / priceSpace -
                          (rangeLarge === rangeSmall ? index / 4 : 0)) *
                          range,
                    ),
                    dragMax: Math.ceil(
                      rangeSmall +
                        ((1 - EDGE_SPACE - index * minimumGap) / priceSpace -
                          (rangeLarge === rangeSmall ? index / 4 : 0)) *
                          range,
                    ),
                    positionScale: priceSpace,
                    description: hintId,
                    onDragging: setDragging,
                    onMove: (next, commit) =>
                      isMiddle
                        ? setMiddle(size, next, commit)
                        : setEndpoint(size, next, commit),
                  }}
                  onApply={(draft) =>
                    isMiddle
                      ? applyMiddle(size, draft)
                      : applyEndpoint(size, draft)
                  }
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
