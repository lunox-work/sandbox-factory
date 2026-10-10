/**
 * The dotted thought-orb (`thinking-orbs`) in the two tones the app waits in.
 *
 * `plain` is the library's own orb, untouched: monochrome ink that follows
 * the theme. It stands beside a page reading what it already has, which
 * should look like no more than it is.
 *
 * `brand` is the same geometry in Lunox's ramp, for a model or an agent at
 * work: the one wait that is making something. The library tints in one
 * colour only, so this paints its frames itself: each mark's ink as alpha,
 * then the ramp filled through them. The library's tint is that ink as
 * coverage over the page in either theme, so depth reads the same in colour
 * as it does in grey.
 */

import { useEffect, useRef, useState } from "react";
import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs";
import {
  MODE_FRAMES,
  resolvePreset,
  type OrbFrame,
} from "thinking-orbs/engine";

import { cn } from "@/lib/utils";

export type { OrbState };

export function Orb({
  state,
  tone,
  size = 20,
  className,
}: {
  /** Which of the library's nine animations: what the wait is doing. */
  state: OrbState;
  tone: "brand" | "plain";
  /** 20 sits in a line of text, 64 beside a heading; 32 between. */
  size?: OrbSize;
  className?: string;
}) {
  return tone === "plain" ? (
    <ThinkingOrb
      aria-hidden="true"
      state={state}
      size={size}
      className={cn("shrink-0", className)}
    />
  ) : (
    <BrandOrb state={state} size={size} className={className} />
  );
}

/** The ramp's stops on light, from `--brand-gradient-vertical`. */
const LIGHT_RAMP: readonly (readonly [number, string])[] = [
  [0, "#47c6f5"],
  [0.25, "#1684fc"],
  [0.5, "#0864ed"],
  [0.75, "#3976ff"],
  [1, "#9985ff"],
];

/**
 * The ramp where the orb sits, read from the stylesheet so the light and
 * dark themes, and the workbench's forced `.dark`, each give their own.
 * Cyan at the top, as the logo runs.
 */
function ramp(ctx: CanvasRenderingContext2D, size: number): CanvasGradient {
  const declared = getComputedStyle(ctx.canvas).getPropertyValue(
    "--brand-gradient-vertical",
  );
  const stops = [...declared.matchAll(/(#[0-9a-f]{3,8})\s+([\d.]+)%/gi)].map(
    ([, color, at]) => [Number(at) / 100, color] as const,
  );
  // The orb's sphere spans the middle 80% of its box.
  const fill = ctx.createLinearGradient(0, size * 0.1, 0, size * 0.9);
  for (const [at, color] of stops.length > 1 ? stops : LIGHT_RAMP)
    fill.addColorStop(at, color as string);
  return fill;
}

/**
 * How much of the ramp a mark shows: the inverse of its paper ink, lifted a
 * little. Blue ink is darker than black is on light or white is on dark, so
 * at the library's own coverage the far side of the sphere goes out first;
 * the lift keeps it in view and barely moves the near dots.
 */
function coverage(mark: { white: number; a?: number }): number {
  const ink = 1 - Math.min(1, Math.max(0, mark.white));
  return ink ** 0.7 * (mark.a ?? 1);
}

function paint(
  ctx: CanvasRenderingContext2D,
  { dots, lines }: OrbFrame,
  fill: CanvasGradient,
  size: number,
) {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = ctx.strokeStyle = "#000";
  for (const line of lines) {
    ctx.globalAlpha = coverage(line);
    ctx.lineWidth = line.w;
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.stroke();
  }
  for (const dot of dots) {
    ctx.globalAlpha = coverage(dot);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === "function" && matchMedia(REDUCED).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = matchMedia(REDUCED);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/**
 * The library component's loop, kept to what it does: one clock shared by
 * every orb so two on a screen move together, stopped offscreen and on a
 * hidden tab, and a single still frame for reduced motion.
 */
function BrandOrb({
  state,
  size,
  className,
}: {
  state: OrbState;
  size: OrbSize;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { mode, speed, opts } = resolvePreset(state, size);
    const geometry = MODE_FRAMES[mode];
    let fill = ramp(ctx, size);
    // The library's own still: t = 0.6 shows every state mid-gesture.
    const draw = () =>
      paint(
        ctx,
        geometry(
          size,
          reduced ? 0.6 : (performance.now() / 1000) * speed,
          opts,
        ),
        fill,
        size,
      );

    let frame = 0;
    let running = false;
    const loop = () => {
      draw();
      if (running) frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || reduced || document.hidden) return;
      running = true;
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    // A theme switch changes the ramp: the OS's, or `.dark`/`.light` forced
    // on the page.
    const retheme = () => {
      fill = ramp(ctx, size);
      if (!running) draw();
    };
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", retheme);
    const forced = new MutationObserver(retheme);
    forced.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    let visible = true;
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) start();
      else stop();
    });
    seen.observe(canvas);
    const shown = () => {
      if (document.hidden) stop();
      else if (visible) start();
    };
    document.addEventListener("visibilitychange", shown);

    draw();
    start();
    return () => {
      stop();
      seen.disconnect();
      forced.disconnect();
      scheme.removeEventListener("change", retheme);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [state, size, reduced]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("block shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
}
